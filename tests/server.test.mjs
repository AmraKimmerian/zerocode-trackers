import test, { after, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.mjs';

const PASSWORD = 'Demo-Tracker-2026';
const CASE = 'team';
let app;
let dataDir;
let base;

async function start() {
  dataDir = await mkdtemp(join(tmpdir(), 'fgip07-tests-'));
  app = createApp({ dataDir, demo: true });
  await new Promise((resolve, reject) => {
    app.server.once('error', reject);
    app.server.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${app.server.address().port}`;
}

async function stop() {
  if (app) {
    await app.close();
    app = undefined;
  }
  if (dataDir) {
    await rm(dataDir, { recursive: true, force: true });
    dataDir = undefined;
  }
}

async function request(path, { method = 'GET', body, cookie, origin } = {}) {
  const headers = {};
  if (body !== undefined || ['POST', 'PUT', 'DELETE'].includes(method)) headers['content-type'] = 'application/json';
  if (cookie) headers.cookie = cookie;
  if (origin) headers.origin = origin;
  const response = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const raw = await response.text();
  let data;
  try { data = raw ? JSON.parse(raw) : undefined; } catch { data = raw; }
  return { response, data, raw };
}

async function login(caseId = CASE, role = 'admin') {
  const { response, data } = await request(`/api/${caseId}/login`, {
    method: 'POST', body: { login: role, password: PASSWORD },
  });
  assert.equal(response.status, 200, `login ${caseId}/${role}: ${JSON.stringify(data)}`);
  const cookie = response.headers.get('set-cookie')?.split(';', 1)[0];
  assert.ok(cookie, 'login should return a session cookie');
  return { cookie, state: data };
}

async function taskInput(state, overrides = {}) {
  return {
    title: 'Тестовая задача', description: 'Описание теста',
    project_id: state.projects[0].id,
    assignee: state.users.find(user => user.role === 'employee').id,
    due: '2030-06-15', category: 'Проверка', status: 'new', priority: 'normal', rating: 0,
    ...overrides,
  };
}

beforeEach(start);
afterEach(stop);

test('закрывает state без входа ответом 401', async () => {
  const { response, data } = await request(`/api/${CASE}/state`);
  assert.equal(response.status, 401);
  assert.match(data.error, /Войдите/);
});

test('выполняет CRUD задачи, сохраняет данные при повторном открытии БД', async () => {
  const { cookie, state } = await login();
  const input = await taskInput(state);
  const created = await request(`/api/${CASE}/tasks`, { method: 'POST', cookie, body: input });
  assert.equal(created.response.status, 201);
  const id = created.data.id;

  let current = await request(`/api/${CASE}/state`, { cookie });
  assert.equal(current.response.status, 200);
  let task = current.data.tasks.find(item => item.id === id);
  assert.equal(task.title, input.title);

  const updated = await request(`/api/${CASE}/tasks/${id}`, {
    method: 'PUT', cookie, body: { ...input, title: 'После перезапуска', version: task.version },
  });
  assert.equal(updated.response.status, 200);

  await app.close();
  app = undefined;
  app = createApp({ dataDir, demo: true });
  await new Promise((resolve, reject) => {
    app.server.once('error', reject);
    app.server.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${app.server.address().port}`;

  current = await request(`/api/${CASE}/state`, { cookie });
  assert.equal(current.response.status, 200, 'session should remain valid after DB reopen');
  task = current.data.tasks.find(item => item.id === id);
  assert.equal(task.title, 'После перезапуска');
  assert.equal(task.version, 2);

  const deleted = await request(`/api/${CASE}/tasks/${id}`, { method: 'DELETE', cookie });
  assert.equal(deleted.response.status, 200);
  current = await request(`/api/${CASE}/state`, { cookie });
  assert.equal(current.data.tasks.some(item => item.id === id), false);
});

test('сотрудник не создаёт и не удаляет задачи и не редактирует чужую', async () => {
  const admin = await login();
  const employeeLogin = await login(CASE, 'employee');
  const owned = employeeLogin.state.tasks[0];
  const чужая = admin.state.tasks.find(task => task.assignee !== employeeLogin.state.user.id);
  assert.ok(чужая);

  const create = await request(`/api/${CASE}/tasks`, {
    method: 'POST', cookie: employeeLogin.cookie,
    body: await taskInput(employeeLogin.state),
  });
  assert.equal(create.response.status, 403);

  const update = await request(`/api/${CASE}/tasks/${чужая.id}`, {
    method: 'PUT', cookie: employeeLogin.cookie,
    body: { status: 'done', version: чужая.version },
  });
  assert.equal(update.response.status, 403);

  const deletion = await request(`/api/${CASE}/tasks/${owned.id}`, {
    method: 'DELETE', cookie: employeeLogin.cookie,
  });
  assert.equal(deletion.response.status, 403);
});

test('сотрудник меняет только статус собственной задачи, а другие кейсы изолированы', async () => {
  const employee = await login(CASE, 'employee');
  const ownTask = employee.state.tasks[0];
  const forbiddenEdit = await request(`/api/${CASE}/tasks/${ownTask.id}`, {
    method: 'PUT', cookie: employee.cookie,
    body: { title: 'Запрещённое изменение', status: 'done', version: ownTask.version },
  });
  assert.equal(forbiddenEdit.response.status, 403);

  const changed = await request(`/api/${CASE}/tasks/${ownTask.id}`, {
    method: 'PUT', cookie: employee.cookie,
    body: { status: 'done', version: ownTask.version },
  });
  assert.equal(changed.response.status, 200);

  const anotherCase = await login('sites', 'admin');
  const siteState = await request('/api/sites/state', { cookie: anotherCase.cookie });
  assert.equal(siteState.response.status, 200);
  assert.ok(siteState.data.tasks.length > 0);
  assert.equal(siteState.data.tasks.some(task => task.id === ownTask.id), false);
  assert.equal(siteState.data.config.name, 'Контур');

  const leak = await request(`/api/sites/tasks/${ownTask.id}`, {
    method: 'DELETE', cookie: anotherCase.cookie,
  });
  assert.equal(leak.response.status, 404);
});

test('отклоняет невалидные поля кодом 400', async () => {
  const { cookie, state } = await login();
  const cases = [
    { title: '', due: '2030-02-30' },
    { title: 'Слишком длинная задача'.repeat(20) },
    { title: 'Неверный статус', status: 'blocked' },
    { title: 'Неверный приоритет', priority: 'urgent' },
    { title: 'Нет исполнителя', assignee: 999999 },
  ];
  for (const patch of cases) {
    const result = await request(`/api/${CASE}/tasks`, {
      method: 'POST', cookie, body: await taskInput(state, patch),
    });
    assert.equal(result.response.status, 400, JSON.stringify(patch));
  }
});

test('отклоняет устаревшую версию задачи кодом 409', async () => {
  const { cookie, state } = await login();
  const task = state.tasks[0];
  const result = await request(`/api/${CASE}/tasks/${task.id}`, {
    method: 'PUT', cookie, body: { ...task, version: task.version + 1 },
  });
  assert.equal(result.response.status, 409);
});

test('поддерживает комментарии, изменение профиля, проект и нового участника', async () => {
  const { cookie, state } = await login();
  const task = state.tasks[0];
  const comment = await request(`/api/${CASE}/tasks/${task.id}/comments`, {
    method: 'POST', cookie, body: { body: 'Проверил, готово.' },
  });
  assert.equal(comment.response.status, 201);
  const comments = await request(`/api/${CASE}/tasks/${task.id}/comments`, { cookie });
  assert.equal(comments.response.status, 200);
  assert.equal(comments.data.at(-1).body, 'Проверил, готово.');

  const profile = await request(`/api/${CASE}/profile`, {
    method: 'PUT', cookie, body: { name: 'Администратор теста' },
  });
  assert.equal(profile.response.status, 200);
  const project = await request(`/api/${CASE}/projects`, {
    method: 'POST', cookie, body: { title: 'Новый тестовый проект' },
  });
  assert.equal(project.response.status, 201);
  const user = await request(`/api/${CASE}/users`, {
    method: 'POST', cookie,
    body: { name: 'Новый сотрудник', login: 'new.employee', password: 'New-Employee-Password-24', role: 'employee' },
  });
  assert.equal(user.response.status, 201);
});

test('выгружает CSV с заголовком и строками задач', async () => {
  const { cookie, state } = await login();
  const exported = await request(`/api/${CASE}/export`, { cookie });
  assert.equal(exported.response.status, 200);
  assert.match(exported.response.headers.get('content-type'), /text\/csv/);
  assert.match(exported.raw, /"Название";"Статус";"Исполнитель";"Срок";"Категория"/);
  assert.ok(exported.raw.split('\r\n').length > state.tasks.length);
});

test('отклоняет изменение с чужим Origin ответом 403', async () => {
  const { cookie, state } = await login();
  const result = await request(`/api/${CASE}/tasks`, {
    method: 'POST', cookie, origin: 'https://attacker.example',
    body: await taskInput(state, { title: 'Cross-origin' }),
  });
  assert.equal(result.response.status, 403);
});

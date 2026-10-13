let currentUser = null;
let selectedContact = null;
let messagePollInterval = null;

async function apiRequest(url, options = {}) {
  const response = await fetch(url, {
    headers: {
      'Content-Type': 'application/json',
      ...options.headers
    },
    credentials: 'include',
    ...options
  });
  
  const data = await response.json();
  
  if (!response.ok) {
    throw new Error(data.error || 'Erro na requisição');
  }
  
  return data;
}

function showScreen(screenId) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(screenId).classList.add('active');
}

function showError(message) {
  const errorEl = document.getElementById('login-error');
  errorEl.textContent = message;
  errorEl.classList.remove('hidden');
}

function hideError() {
  document.getElementById('login-error').classList.add('hidden');
}

async function checkAuth() {
  try {
    const data = await apiRequest('/api/me');
    currentUser = data.user;
    showChatScreen();
  } catch (e) {
    showScreen('login-screen');
  }
}

async function login(username, password) {
  hideError();
  try {
    const data = await apiRequest('/api/login', {
      method: 'POST',
      body: JSON.stringify({ username, password })
    });
    currentUser = data.user;
    showChatScreen();
  } catch (e) {
    showError(e.message);
  }
}

async function logout() {
  try {
    await apiRequest('/api/logout', { method: 'POST' });
    currentUser = null;
    selectedContact = null;
    if (messagePollInterval) clearInterval(messagePollInterval);
    showScreen('login-screen');
    document.getElementById('login-form').reset();
  } catch (e) {
    console.error('Logout error:', e);
  }
}

async function loadContacts() {
  try {
    const data = await apiRequest('/api/users');
    renderContacts(data.users);
  } catch (e) {
    console.error('Failed to load contacts:', e);
  }
}

function renderContacts(users) {
  const list = document.getElementById('contacts-list');
  list.innerHTML = '';
  
  users.forEach(user => {
    const li = document.createElement('li');
    li.className = 'contact-item' + (selectedContact && selectedContact.id === user.id ? ' active' : '');
    li.dataset.userId = user.id;
    li.innerHTML = `
      <div class="contact-avatar">${user.username.charAt(0).toUpperCase()}</div>
      <span class="contact-name">${user.username}</span>
    `;
    li.addEventListener('click', () => selectContact(user));
    list.appendChild(li);
  });
}

async function selectContact(contact) {
  selectedContact = contact;
  document.querySelectorAll('.contact-item').forEach(item => {
    item.classList.toggle('active', item.dataset.userId == contact.id);
  });
  
  document.getElementById('no-chat-selected').classList.add('hidden');
  document.getElementById('chat-container').classList.remove('hidden');
  document.getElementById('chat-title').textContent = `Conversa com ${contact.username}`;
  
  await loadMessages();
  startMessagePolling();
}

async function loadMessages() {
  if (!selectedContact) return;
  
  try {
    const data = await apiRequest(`/api/messages/${selectedContact.id}`);
    renderMessages(data.messages);
  } catch (e) {
    console.error('Failed to load messages:', e);
  }
}

function renderMessages(messages) {
  const area = document.getElementById('messages-area');
  area.innerHTML = '';
  
  messages.forEach(msg => {
    const div = document.createElement('div');
    div.className = `message ${msg.sender_id === currentUser.id ? 'sent' : 'received'}`;
    const time = new Date(msg.created_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    div.innerHTML = `
      <div class="message-header">
        <span class="message-sender">${msg.sender_name}</span>
        <span class="message-time">${time}</span>
      </div>
      <div class="message-content">${escapeHtml(msg.content)}</div>
    `;
    area.appendChild(div);
  });
  
  area.scrollTop = area.scrollHeight;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

async function sendMessage(content) {
  if (!selectedContact || !content.trim()) return;
  
  try {
    await apiRequest('/api/messages', {
      method: 'POST',
      body: JSON.stringify({ recipientId: selectedContact.id, content })
    });
    document.getElementById('message-input').value = '';
    await loadMessages();
  } catch (e) {
    console.error('Failed to send message:', e);
    alert('Erro ao enviar mensagem: ' + e.message);
  }
}

function startMessagePolling() {
  if (messagePollInterval) clearInterval(messagePollInterval);
  messagePollInterval = setInterval(loadMessages, 2000);
}

function showChatScreen() {
  showScreen('chat-screen');
  document.getElementById('current-user').textContent = currentUser.username;
  loadContacts();
}

document.getElementById('login-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const username = document.getElementById('username').value.trim();
  const password = document.getElementById('password').value;
  login(username, password);
});

document.getElementById('logout-btn').addEventListener('click', logout);

document.getElementById('message-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = document.getElementById('message-input');
  sendMessage(input.value);
});

checkAuth();
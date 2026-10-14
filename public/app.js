let currentUser = null;
let selectedContact = null;
let ws = null;
let replyTo = null;
let editingMessageId = null;
let audioRecorder = null;
let audioChunks = [];
let audioStream = null;
let audioStartTime = 0;
let audioTimerInterval = null;
let audioContext = null;
let audioAnalyser = null;
let lastMessageIds = new Set();
let hasMoreMessages = false;
let oldestMessageId = null;
let isLoadingOlder = false;
let typingTimeout = null;
let typingUsers = new Set();
let searchQuery = '';
let pinnedMessages = new Set();
let onlineUsers = new Map();
let lastReadMessageId = null;
let messageSearchTimeout = null;
let allContacts = [];

async function apiRequest(url, options = {}) {
  const response = await fetch(url, {
    headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}) },
    credentials: 'include',
    ...options
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Erro na requisição');
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
    applyTheme(currentUser.theme || 'system');
    showScreen('chat-screen');
    connectWebSocket();
    loadContacts();
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
    applyTheme(currentUser.theme || 'system');
    showScreen('chat-screen');
    connectWebSocket();
    loadContacts();
  } catch (e) {
    showError(e.message);
  }
}

async function logout() {
  try {
    await apiRequest('/api/logout', { method: 'POST' });
    if (ws) ws.close();
    currentUser = null;
    selectedContact = null;
    showScreen('login-screen');
    document.body.classList.remove('mobile-chat-open');
    document.getElementById('login-form').reset();
  } catch (e) {
    console.error('Logout error:', e);
  }
}

function connectWebSocket() {
  if (ws && ws.readyState <= 1) return;
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${protocol}//${location.host}`);
  ws.onmessage = (event) => handleWsMessage(JSON.parse(event.data));
  ws.onclose = () => {
    if (currentUser) setTimeout(connectWebSocket, 3000);
  };
}

function handleWsMessage(data) {
  if (!selectedContact) {
    if (data.type === 'new_message') loadContacts();
    // Handle other events even without selected contact
    if (data.type === 'presence_update') loadContacts();
    if (data.type === 'typing_update') {
      // Show toast for typing when no contact selected
      showToast(`${data.username} está digitando`, 'info');
    }
    return;
  }
  switch (data.type) {
    case 'new_message': {
      const m = data.message;
      const isRelevant = (m.sender_id === currentUser.id || m.recipient_id === currentUser.id) &&
        (m.sender_id === selectedContact.id || m.recipient_id === selectedContact.id);
      if (isRelevant) {
        appendMessage(m);
        if (m.sender_id !== currentUser.id) {
          fetch(`/api/messages/${m.id}/read`, { method: 'POST', credentials: 'include' }).catch(() => {});
        }
      } else if (m.sender_id !== currentUser.id) loadContacts();
      break;
    }
    case 'message_updated': {
      if (data.message.id) updateMessageElement(data.message);
      break;
    }
    case 'message_deleted': {
      if (data.forEveryone) {
        updateMessageElement({ id: data.messageId, sender_id: 0, sender_name: '', created_at: '', deleted_at: 1, deleted_for_everyone: 1, type: 'text', reactions: [] });
      } else {
        removeMessageElement(data.messageId);
      }
      break;
    }
    case 'reactions_updated': {
      updateReactionsElement(data.messageId, data.reactions);
      break;
    }
    case 'typing_update': {
      if (data.status === 'typing') {
        showTypingIndicator(data.userId);
      } else {
        hideTypingIndicator(data.userId);
      }
      break;
    }
    case 'presence_update': {
      // Update online users map
      if (data.userId && data.status) {
        onlineUsers.set(data.userId, data.status);
        // Re-render contacts to show online status
        loadContacts();
      }
      break;
    }
    case 'message_read': {
      const el = document.querySelector(`.message[data-message-id="${data.messageId}"]`);
      if (el && data.messageId) {
        let receipt = el.querySelector('.read-receipt');
        if (!receipt) {
          receipt = document.createElement('span');
          receipt.className = 'read-receipt';
          receipt.textContent = '✓✓';
          const header = el.querySelector('.message-header');
          if (header) header.appendChild(receipt);
        }
      }
      break;
    }
  }
}

async function loadContacts() {
  try {
    const data = await apiRequest('/api/users');
    // Also load online status
    try {
      const onlineData = await apiRequest('/api/users/online');
      onlineData.users.forEach(u => {
        onlineUsers.set(u.id, u.status || 'offline');
      });
    } catch (e) {
      console.warn('Failed to load online status:', e);
    }
    renderContacts(data.users);
  } catch (e) {
    console.error('Failed to load contacts:', e);
    showToast('Erro ao carregar contatos', 'error');
  }
}

function renderContacts(users) {
  allContacts = users || [];
  const list = document.getElementById('contacts-list');
  list.innerHTML = '';
  if (!users || !users.length) {
    list.innerHTML = '<li class="contact-item"><span>Nenhum contato</span></li>';
    return;
  }
  users.forEach(user => {
    list.appendChild(buildContactItem(user));
  });
  applyContactFilter();
}

function buildContactItem(user) {
  const li = document.createElement('li');
  li.className = 'contact-item' + (selectedContact && selectedContact.id === user.id ? ' active' : '');
  li.dataset.userId = user.id;
  const status = onlineUsers.get(user.id) || 'offline';
  const statusClass = status === 'online' ? 'online' : status === 'typing' ? 'typing' : 'offline';
  const avatar = user.avatar_url
    ? `<img class="contact-avatar" src="${user.avatar_url}" alt="${user.username}">`
    : `<div class="contact-avatar">${user.username.charAt(0).toUpperCase()}</div>`;
  li.innerHTML = `${avatar}<span class="contact-name">${escapeHtml(user.username)}</span><span class="contact-status ${statusClass}"></span>`;
  li.addEventListener('click', () => selectContact(user));
  return li;
}

function applyContactFilter() {
  const search = document.getElementById('contact-search');
  const q = (search && search.value ? search.value : '').trim().toLowerCase();
  const filtered = q
    ? allContacts.filter(u => u.username.toLowerCase().includes(q))
    : allContacts;
  const list = document.getElementById('contacts-list');
  list.innerHTML = '';
  if (!filtered.length) {
    list.innerHTML = '<li class="contact-item"><span>Nenhum contato encontrado</span></li>';
    return;
  }
  filtered.forEach(user => list.appendChild(buildContactItem(user)));
}

async function selectContact(contact) {
  selectedContact = contact;
  replyTo = null;
  editingMessageId = null;
  document.getElementById('reply-preview').classList.add('hidden');
  document.querySelectorAll('.contact-item').forEach(item => {
    item.classList.toggle('active', item.dataset.userId == contact.id);
  });
  document.getElementById('no-chat-selected').classList.add('hidden');
  document.getElementById('chat-container').classList.remove('hidden');
  document.getElementById('chat-title').textContent = `Conversa com ${contact.username}`;
  markConversationAsRead(contact.id);
  typingUsers.clear();
  renderTypingIndicator();
  await loadMessages();
  const area = document.getElementById('messages-area');
  area.onscroll = () => {
    if (isLoadingOlder || !hasMoreMessages || !oldestMessageId) return;
    if (area.scrollTop < 20) {
      isLoadingOlder = true;
      loadMessages(oldestMessageId).finally(() => { isLoadingOlder = false; });
    }
  };
  document.body.classList.add('mobile-chat-open');
}

function markConversationAsRead(otherUserId) {
  fetch(`/api/conversations/${otherUserId}/read`, {
    method: 'POST',
    credentials: 'include'
  }).catch(() => {});
}

async function loadMessages(before) {
  if (!selectedContact) return;
  try {
    const params = new URLSearchParams({ limit: '50' });
    if (before) params.set('before', before);
    const data = await apiRequest(`/api/messages/${selectedContact.id}?${params.toString()}`);
    if (before) {
      const area = document.getElementById('messages-area');
      const prevScrollHeight = area.scrollHeight;
      const prevScrollTop = area.scrollTop;
      const frag = document.createDocumentFragment();
      data.messages.forEach(msg => {
        if (lastMessageIds.has(msg.id)) return;
        lastMessageIds.add(msg.id);
        frag.appendChild(buildMessageElement(msg));
      });
      if (frag.childNodes.length) {
        area.insertBefore(frag, area.firstChild);
        area.scrollTop = prevScrollTop + (area.scrollHeight - prevScrollHeight);
      }
    } else {
      lastMessageIds = new Set(data.messages.map(m => m.id));
      renderMessages(data.messages);
    }
    if (data.messages.length) {
      oldestMessageId = data.messages[0].id;
    }
    hasMoreMessages = data.messages.length >= 50;
  } catch (e) {
    console.error('Failed to load messages:', e);
  }
}

function renderMessages(messages) {
  const area = document.getElementById('messages-area');
  if (!area) return;
  area.innerHTML = '';

  let lastDateLabel = null;
  messages.forEach(msg => {
    const dateLabel = formatDateSeparator(msg.created_at);
    if (dateLabel !== lastDateLabel) {
      lastDateLabel = dateLabel;
      const dateEl = document.createElement('div');
      dateEl.className = 'message-date-separator';
      dateEl.dataset.date = dateLabel;
      dateEl.textContent = dateLabel;
      area.appendChild(dateEl);
    }
    area.appendChild(buildMessageElement(msg));
  });

  area.scrollTop = area.scrollHeight;
}

function renderReactions(reactions) {
  if (!reactions || !reactions.length) return '';
  const grouped = {};
  for (const r of reactions) {
    if (!grouped[r.emoji]) grouped[r.emoji] = { emoji: r.emoji, count: 0, own: false, users: [] };
    grouped[r.emoji].count++;
    if (r.user_id === currentUser.id) grouped[r.emoji].own = true;
    if (r.username && !grouped[r.emoji].users.includes(r.username)) grouped[r.emoji].users.push(r.username);
  }
  return `<div class="message-reactions">` + Object.values(grouped).map(g =>
    `<button type="button" class="reaction${g.own ? ' own' : ''}" data-emoji="${escapeHtml(g.emoji)}" title="${escapeHtml(g.users.join(', '))}">${g.emoji}<span class="reaction-count">${g.count}</span></button>`
  ).join('') + `</div>`;
}

function buildMessageElement(msg) {
  const div = document.createElement('div');
  div.className = `message ${msg.sender_id === currentUser.id ? 'sent' : 'received'}`;
  div.dataset.messageId = msg.id;
  if (msg.deleted_at) div.classList.add('deleted');
  if (msg.edited_at && !msg.deleted_at) div.classList.add('edited');

  const time = formatTime(msg.created_at);
  const isMine = msg.sender_id === currentUser.id;
  const readReceipt = isMine && msg.read_at ? '<span class="read-receipt">✓✓</span>' : '';

  let bodyHtml = '';
  if (msg.deleted_at) {
    bodyHtml = `<div class="message-content"><em>Mensagem apagada</em></div>`;
  } else {
    if (msg.reply_to_id) {
      bodyHtml += `<div class="message-reply">↩ respondendo</div>`;
    }
    if (msg.is_pinned) {
      bodyHtml += '<div class="message-pinned">📌 Mensagem fixada</div>';
    }
    switch (msg.type) {
      case 'image':
        bodyHtml += `<img class="message-image" src="${msg.media_url}" alt="imagem" loading="lazy" onclick="openImageModal(this.src)">`;
        break;
      case 'audio':
        bodyHtml += buildAudioHtml(msg);
        break;
      default:
        bodyHtml += `<div class="message-content">${escapeHtml(msg.content)}</div>`;
    }
  }

  bodyHtml += renderReactions(msg.reactions);

  div.innerHTML = `
    <div class="message-header">
      <span class="message-sender">${escapeHtml(msg.sender_name)}</span>
      <span class="message-time">${time}</span>
      ${readReceipt}
    </div>
    ${bodyHtml}
  `;

  const audioAudio = div.querySelector('audio');
  if (audioAudio) setupAudio(div, msg);

  div.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    openContextMenu(e, msg, isMine);
  });

  div.addEventListener('click', (e) => {
    if (e.target.closest('.reaction-btn, .context-menu, .audio-play-btn')) return;
    openQuickReactions(e, msg);
  });

  div.querySelectorAll('.reaction').forEach(btn => {
    btn.addEventListener('click', () => toggleReaction(msg.id, btn.dataset.emoji));
  });

  return div;
}

function buildAudioHtml(msg) {
  const duration = msg.media_duration ? formatDuration(msg.media_duration) : '0:00';
  return `
    <div class="message-audio">
      <button type="button" class="audio-play-btn" aria-label="Reproduzir áudio">▶</button>
      <div class="audio-waveform" aria-hidden="true">
        ${Array.from({ length: 22 }, (_, i) => `<span class="audio-bar" style="height:${20 + Math.round(Math.abs(Math.sin(i * 0.7)) * 60)}%"></span>`).join('')}
      </div>
      <span class="audio-time">${duration}</span>
      <audio src="${msg.media_url}" preload="metadata"></audio>
    </div>
  `;
}

function setupAudio(div, msg) {
  const btn = div.querySelector('.audio-play-btn');
  const audio = div.querySelector('audio');
  if (!btn || !audio) return;
  btn.addEventListener('click', () => {
    if (audio.paused) audio.play();
    else audio.pause();
  });
  audio.addEventListener('play', () => { btn.textContent = '⏸'; });
  audio.addEventListener('pause', () => { btn.textContent = '▶'; });
  audio.addEventListener('ended', () => { btn.textContent = '▶'; });
}

function appendMessage(msg) {
  if (lastMessageIds.has(msg.id)) {
    updateMessageElement(msg);
    return;
  }
  lastMessageIds.add(msg.id);
  const area = document.getElementById('messages-area');
  area.appendChild(buildMessageElement(msg));
  area.scrollTop = area.scrollHeight;
}

function updateMessageElement(msg) {
  const el = document.querySelector(`.message[data-message-id="${msg.id}"]`);
  if (!el) return;
  const newEl = buildMessageElement(msg);
  el.replaceWith(newEl);
}

function removeMessageElement(messageId) {
  const el = document.querySelector(`.message[data-message-id="${messageId}"]`);
  if (el) el.remove();
  lastMessageIds.delete(messageId);
}

function updateReactionsElement(messageId, reactions) {
  const el = document.querySelector(`.message[data-message-id="${messageId}"]`);
  if (!el) return;
  const container = el.querySelector('.message-reactions');
  if (!reactions.length) {
    if (container) container.remove();
    return;
  }
  const html = renderReactions(reactions);
  if (container) container.outerHTML = html;
  else el.insertAdjacentHTML('beforeend', html);
  el.querySelectorAll('.reaction').forEach(btn => {
    btn.addEventListener('click', () => toggleReaction(messageId, btn.dataset.emoji));
  });
}

function formatTime(dateStr) {
  if (!dateStr) return '';
  return new Date(dateStr + 'Z').toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

function formatDuration(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// Toast notifications
function showToast(message, type = 'info', duration = 3000) {
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    container.style.cssText = 'position:fixed;top:20px;right:20px;z-index:10000;display:flex;flex-direction:column;gap:8px';
    document.body.appendChild(container);
  }
  
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  toast.style.cssText = `
    background:${type === 'error' ? '#ef4444' : type === 'success' ? '#10b981' : '#3b82f6'};
    color:white;padding:12px 16px;border-radius:8px;box-shadow:0 4px 12px rgba(0,0,0,0.3);
    animation:slideIn 0.3s ease;max-width:300px;
  `;
  container.appendChild(toast);
  
  setTimeout(() => {
    toast.style.animation = 'slideOut 0.3s ease';
    setTimeout(() => toast.remove(), 300);
  }, duration);
}

// Typing indicator UI
function showTypingIndicator(userId) {
  if (!selectedContact || userId !== selectedContact.id) return;
  typingUsers.add(userId);
  renderTypingIndicator();
}

function hideTypingIndicator(userId) {
  typingUsers.delete(userId);
  renderTypingIndicator();
}

function renderTypingIndicator() {
  let indicator = document.getElementById('typing-indicator');
  if (!indicator) {
    indicator = document.createElement('div');
    indicator.id = 'typing-indicator';
    indicator.className = 'typing-indicator hidden';
    const area = document.getElementById('messages-area');
    area.parentNode.insertBefore(indicator, area.nextSibling);
  }
  
  if (typingUsers.size > 0) {
    const names = Array.from(typingUsers).map(id => {
      if (id === selectedContact.id) return selectedContact.username;
      return 'Alguém';
    });
    indicator.innerHTML = `${names.join(', ')} ${typingUsers.size === 1 ? 'está digitando' : 'estão digitando'}...`;
    indicator.classList.remove('hidden');
    // Scroll to bottom to show indicator
    const area = document.getElementById('messages-area');
    area.scrollTop = area.scrollHeight;
  } else {
    indicator.classList.add('hidden');
  }
}

// Auto-resize textarea
function autoResizeTextarea(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 150) + 'px';
}

// Copy message to clipboard
function copyMessageText(messageId) {
  const el = document.querySelector(`.message[data-message-id="${messageId}"] .message-content`);
  if (el) {
    navigator.clipboard.writeText(el.textContent).then(() => {
      showToast('Mensagem copiada', 'success');
    }).catch(() => {
      showToast('Erro ao copiar', 'error');
    });
  }
}

// Format relative time
function formatRelativeTime(dateStr) {
  if (!dateStr) return '';
  const date = new Date(dateStr + 'Z');
  const now = new Date();
  const diff = now - date;
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);
  
  if (minutes < 1) return 'agora';
  if (minutes < 60) return `${minutes}min`;
  if (hours < 24) return `${hours}h`;
  if (days < 7) return `${days}d`;
  return date.toLocaleDateString('pt-BR');
}

// Date separator helper
function formatDateSeparator(dateStr) {
  if (!dateStr) return '';
  const date = new Date(dateStr + 'Z');
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const msgDate = new Date(date);
  msgDate.setHours(0, 0, 0, 0);
  
  const diff = (today - msgDate) / 86400000;
  if (diff === 0) return 'Hoje';
  if (diff === 1) return 'Ontem';
  return date.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text == null ? '' : text;
  return div.innerHTML;
}

async function sendMessage(content) {
  if (!selectedContact) return;
  const trimmed = content.trim();
  if (!trimmed) return;
  try {
    if (editingMessageId) {
      await apiRequest(`/api/messages/${editingMessageId}`, {
        method: 'PATCH',
        body: JSON.stringify({ content: trimmed })
      });
      editingMessageId = null;
    } else {
      await apiRequest('/api/messages', {
        method: 'POST',
        body: JSON.stringify({
          recipientId: selectedContact.id,
          content: trimmed,
          replyToId: replyTo ? replyTo.id : null
        })
      });
    }
    document.getElementById('message-input').value = '';
    cancelReply();
  } catch (e) {
    alert('Erro ao enviar mensagem: ' + e.message);
  }
}

async function sendFile(file, type) {
  if (!selectedContact) return;
  const formData = new FormData();
  formData.append('file', file);
  formData.append('recipientId', selectedContact.id);
  formData.append('type', type);
  if (replyTo) formData.append('replyToId', replyTo.id);
  try {
    const response = await fetch('/api/messages/media', {
      method: 'POST',
      credentials: 'include',
      body: formData
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Erro no upload');
    cancelReply();
    return data.message;
  } catch (e) {
    alert('Erro no upload: ' + e.message);
  }
}

async function toggleReaction(messageId, emoji) {
  try {
    const el = document.querySelector(`.message[data-message-id="${messageId}"]`);
    const existing = el && el.querySelector(`.reaction.own[data-emoji="${emoji}"]`);
    if (existing) {
      await apiRequest(`/api/messages/${messageId}/reactions/${encodeURIComponent(emoji)}`, { method: 'DELETE' });
    } else {
      await apiRequest(`/api/messages/${messageId}/reactions`, {
        method: 'POST',
        body: JSON.stringify({ emoji })
      });
    }
  } catch (e) {
    console.error('Reaction error:', e);
  }
}

function openContextMenu(e, msg, isMine) {
  const menu = document.getElementById('context-menu');
  menu.dataset.messageId = msg.id;
  menu.dataset.isMine = isMine;
  menu.querySelectorAll('.context-menu-item').forEach(item => {
    const action = item.dataset.action;
    if (!isMine && (action === 'edit' || action === 'delete' || action === 'delete-everyone')) {
      item.style.display = 'none';
    } else {
      item.style.display = 'flex';
    }
  });
  // Show first so the element has measurable dimensions
  menu.classList.remove('hidden');
  hideReactionPicker();

  const margin = 8;
  const menuWidth = menu.offsetWidth || 180;
  const menuHeight = menu.offsetHeight || 220;
  const maxLeft = Math.max(margin, window.innerWidth - menuWidth - margin);
  const maxTop = Math.max(margin, window.innerHeight - menuHeight - margin);
  const left = Math.min(Math.max(margin, e.clientX), maxLeft);
  const top = Math.min(Math.max(margin, e.clientY), maxTop);
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
}

function openQuickReactions(e, msg) {
  const picker = document.getElementById('reaction-picker');
  picker.dataset.messageId = msg.id;
  const rect = e.currentTarget.getBoundingClientRect();
  picker.classList.remove('hidden');
  hideContextMenu();

  const margin = 8;
  const pickerWidth = picker.offsetWidth || 260;
  const pickerHeight = picker.offsetHeight || 50;
  const maxLeft = Math.max(margin, window.innerWidth - pickerWidth - margin);
  const maxTop = Math.max(margin, window.innerHeight - pickerHeight - margin);
  const left = Math.min(Math.max(margin, rect.left), maxLeft);
  const top = Math.min(Math.max(margin, rect.top - 50), maxTop);
  picker.style.left = `${left}px`;
  picker.style.top = `${top}px`;
}

function hideContextMenu() {
  document.getElementById('context-menu').classList.add('hidden');
}

function hideReactionPicker() {
  document.getElementById('reaction-picker').classList.add('hidden');
}

async function handleContextAction(action, messageId) {
  if (!messageId) return;
  try {
    switch (action) {
      case 'reply': {
        const msg = { id: messageId, content: getMessageContent(messageId) };
        replyTo = msg;
        document.getElementById('reply-preview-text').innerHTML = `Respondendo: <strong>${escapeHtml(msg.content.substring(0, 60))}</strong>`;
        document.getElementById('reply-preview').classList.remove('hidden');
        document.getElementById('message-input').focus();
        break;
      }
      case 'edit': {
        editingMessageId = messageId;
        const content = getMessageContent(messageId);
        document.getElementById('message-input').value = content;
        document.getElementById('message-input').focus();
        break;
      }
      case 'delete':
        await apiRequest(`/api/messages/${messageId}`, { method: 'DELETE', body: JSON.stringify({ forEveryone: false }) });
        break;
      case 'delete-everyone':
        if (confirm('Apagar para todos?')) {
          await apiRequest(`/api/messages/${messageId}`, { method: 'DELETE', body: JSON.stringify({ forEveryone: true }) });
        }
        break;
      case 'react':
        break;
    }
  } catch (e) {
    alert('Erro: ' + e.message);
  }
  hideContextMenu();
}

function getMessageContent(messageId) {
  const el = document.querySelector(`.message[data-message-id="${messageId}"] .message-content`);
  return el ? el.textContent : '';
}

function cancelReply() {
  replyTo = null;
  editingMessageId = null;
  document.getElementById('reply-preview').classList.add('hidden');
  document.getElementById('message-input').value = '';
}

function applyTheme(theme) {
  const resolved = theme === 'system'
    ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
    : theme;
  document.documentElement.dataset.theme = resolved;
  document.getElementById('theme-icon').textContent = resolved === 'dark' ? '☀️' : '🌙';
}

async function toggleTheme() {
  const current = document.documentElement.dataset.theme;
  const next = current === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  try {
    await apiRequest('/api/me', { method: 'PATCH', body: JSON.stringify({ theme: next }) });
  } catch (e) {
    console.error('Failed to save theme:', e);
  }
}

async function startAudioRecording() {
  if (!navigator.mediaDevices || !window.MediaRecorder) {
    alert('Gravação de áudio não suportada neste navegador');
    return;
  }
  try {
    audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    audioChunks = [];
    audioRecorder = new MediaRecorder(audioStream);
    audioRecorder.ondataavailable = (e) => audioChunks.push(e.data);
    audioRecorder.onstop = () => {
      if (audioStream) {
        audioStream.getTracks().forEach(t => t.stop());
        audioStream = null;
      }
      if (audioContext) {
        audioContext.close().catch(() => {});
        audioContext = null;
        audioAnalyser = null;
      }
    };

    audioContext = new AudioContext();
    const source = audioContext.createMediaStreamSource(audioStream);
    audioAnalyser = audioContext.createAnalyser();
    audioAnalyser.fftSize = 64;
    source.connect(audioAnalyser);

    document.getElementById('audio-recorder').classList.remove('hidden');
    document.getElementById('audio-stop').disabled = false;
    document.getElementById('audio-send').disabled = true;
    document.getElementById('audio-btn').classList.add('recording');

    audioStartTime = Date.now();
    audioTimerInterval = setInterval(updateAudioTimer, 100);
    updateAudioVisualizer();

    audioRecorder.start();
  } catch (e) {
    alert('Não foi possível acessar o microfone: ' + e.message);
  }
}

function updateAudioTimer() {
  const elapsed = Math.floor((Date.now() - audioStartTime) / 1000);
  document.getElementById('audio-timer').textContent = formatDuration(elapsed);
}

function updateAudioVisualizer() {
  if (!audioAnalyser) return;
  const bufferLength = audioAnalyser.frequencyBinCount;
  const dataArray = new Uint8Array(bufferLength);
  const container = document.getElementById('audio-visualizer');

  if (!container.children.length) {
    for (let i = 0; i < 12; i++) {
      const bar = document.createElement('div');
      bar.className = 'audio-bar-visual';
      bar.style.height = '4px';
      container.appendChild(bar);
    }
  }

  audioAnalyser.getByteFrequencyData(dataArray);
  const bars = container.children;
  for (let i = 0; i < bars.length; i++) {
    const value = Math.max(4, (dataArray[i * 2] / 255) * 60);
    bars[i].style.height = `${value}px`;
  }
  if (audioRecorder && audioRecorder.state === 'recording') requestAnimationFrame(updateAudioVisualizer);
}

function stopAudioRecording() {
  clearInterval(audioTimerInterval);
  document.getElementById('audio-stop').disabled = true;
  document.getElementById('audio-send').disabled = false;
  if (audioRecorder && audioRecorder.state === 'recording') {
    audioRecorder.stop();
  }
}

function cancelAudioRecording() {
  if (audioRecorder && audioRecorder.state === 'recording') audioRecorder.stop();
  audioChunks = [];
  clearInterval(audioTimerInterval);
  closeAudioRecorder();
}

function closeAudioRecorder() {
  document.getElementById('audio-recorder').classList.add('hidden');
  document.getElementById('audio-btn').classList.remove('recording');
  document.getElementById('audio-timer').textContent = '00:00';
  const container = document.getElementById('audio-visualizer');
  if (container) container.innerHTML = '';
  if (audioContext) {
    audioContext.close().catch(() => {});
    audioContext = null;
  }
  if (audioStream) {
    audioStream.getTracks().forEach(t => t.stop());
    audioStream = null;
  }
  audioRecorder = null;
  audioAnalyser = null;
}

async function sendAudioRecording() {
  if (!audioChunks.length) return;
  const blob = new Blob(audioChunks, { type: 'audio/webm' });
  const extension = blob.type.split('/')[1] || 'webm';
  const file = new File([blob], `audio-${Date.now()}.${extension}`, { type: blob.type });
  const duration = Math.floor((Date.now() - audioStartTime) / 1000);

  closeAudioRecorder();

  const message = await sendFile(file, 'audio');
  if (message && message.type === 'audio' && !message.media_duration) {
    apiRequest('/api/audio-duration', {
      method: 'POST',
      body: JSON.stringify({ messageId: message.id, duration })
    }).catch(() => {});
  }
}

function openImageModal(src) {
  const modal = document.createElement('div');
  modal.className = 'modal';
  modal.innerHTML = `<div class="modal-content" style="max-width:90vw;max-height:90vh;background:transparent;box-shadow:none;padding:0">
    <img src="${src}" style="max-width:100%;max-height:85vh;border-radius:12px">
    <div style="text-align:center;margin-top:12px"><button class="btn btn-secondary btn-sm" id="close-img-btn">Fechar</button></div>
  </div>`;
  modal.addEventListener('click', () => modal.remove());
  document.body.appendChild(modal);
  modal.querySelector('#close-img-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    modal.remove();
  });
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('login-form').addEventListener('submit', (e) => {
    e.preventDefault();
    login(
      document.getElementById('username').value.trim(),
      document.getElementById('password').value
    );
  });

  document.getElementById('logout-btn').addEventListener('click', logout);
  document.getElementById('theme-toggle').addEventListener('click', toggleTheme);

  const backBtn = document.getElementById('back-btn');
  if (backBtn) {
    backBtn.addEventListener('click', () => {
      document.body.classList.remove('mobile-chat-open');
    });
  }

  document.getElementById('message-form').addEventListener('submit', (e) => {
    e.preventDefault();
    sendMessage(document.getElementById('message-input').value);
  });

  const messageInput = document.getElementById('message-input');
  messageInput.addEventListener('input', () => {
    if (!selectedContact || !ws || ws.readyState !== 1) return;
    ws.send(JSON.stringify({ type: 'typing_start', recipientId: selectedContact.id }));
    clearTimeout(typingTimeout);
    typingTimeout = setTimeout(() => {
      if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'typing_stop', recipientId: selectedContact.id }));
      }
    }, 2000);
  });

  document.getElementById('contact-search').addEventListener('input', applyContactFilter);

  document.getElementById('attach-btn').addEventListener('click', () => {
    document.getElementById('file-input').click();
  });

  document.getElementById('file-input').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const type = file.type.startsWith('audio/') ? 'audio' : 'image';
    sendFile(file, type);
    e.target.value = '';
  });

  document.getElementById('audio-btn').addEventListener('click', startAudioRecording);

  document.getElementById('audio-stop').addEventListener('click', stopAudioRecording);
  document.getElementById('audio-cancel').addEventListener('click', cancelAudioRecording);
  document.getElementById('audio-send').addEventListener('click', sendAudioRecording);

  document.getElementById('reply-cancel').addEventListener('click', cancelReply);

  document.querySelectorAll('.context-menu-item').forEach(item => {
    item.addEventListener('click', () => {
      const menu = document.getElementById('context-menu');
      handleContextAction(item.dataset.action, parseInt(menu.dataset.messageId));
    });
  });

  document.querySelectorAll('.reaction-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const picker = document.getElementById('reaction-picker');
      toggleReaction(parseInt(picker.dataset.messageId), btn.dataset.emoji);
      hideReactionPicker();
    });
  });

  window.addEventListener('click', (e) => {
    if (!e.target.closest('.context-menu') && !e.target.closest('.message')) {
      hideContextMenu();
    }
    if (!e.target.closest('.reaction-picker') && !e.target.closest('.message')) {
      hideReactionPicker();
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      hideContextMenu();
      hideReactionPicker();
      if (replyTo || editingMessageId) cancelReply();
    }
  });

  checkAuth();
});

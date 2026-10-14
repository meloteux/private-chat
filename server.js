const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const sqlite3 = require('sqlite3');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const multer = require('multer');
const { WebSocketServer } = require('ws');

const logFile = path.join(__dirname, 'server.log');
const LOG_LEVELS = { ERROR: 0, WARN: 1, INFO: 2, DEBUG: 3 };
const LOG_LEVEL = process.env.LOG_LEVEL || 'INFO';

class Logger {
  constructor() {
    this.level = LOG_LEVELS[LOG_LEVEL] || LOG_LEVELS.INFO;
  }
  
  format(level, message, meta = {}) {
    const timestamp = new Date().toISOString();
    const logEntry = { timestamp, level, message, ...meta };
    const line = JSON.stringify(logEntry) + '\n';
    
    if (this.level <= LOG_LEVELS[level]) {
      console.log(`${level}: ${message}`);
      try {
        fs.appendFileSync(logFile, line);
      } catch (e) {
        console.error('Failed to write log:', e.message);
      }
    }
  }
  
  error(message, meta = {}) {
    this.format('ERROR', message, meta);
  }
  
  warn(message, meta = {}) {
    this.format('WARN', message, meta);
  }
  
  info(message, meta = {}) {
    this.format('INFO', message, meta);
  }
  
  debug(message, meta = {}) {
    this.format('DEBUG', message, meta);
  }
}

const logger = new Logger();

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const dbPath = path.join(__dirname, 'chat.db');
const db = new sqlite3.Database(dbPath);
db.run('PRAGMA foreign_keys = ON');

const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Rate limiting
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW = 60000; // 1 minute
const RATE_LIMIT_MAX_REQUESTS = 30; // max requests per window

function rateLimiter(req, res, next) {
  const ip = req.ip || req.connection.remoteAddress;
  const now = Date.now();
  
  if (!rateLimitMap.has(ip)) {
    rateLimitMap.set(ip, { count: 1, startTime: now });
    return next();
  }
  
  const record = rateLimitMap.get(ip);
  if (now - record.startTime > RATE_LIMIT_WINDOW) {
    // Reset window
    rateLimitMap.set(ip, { count: 1, startTime: now });
    return next();
  }
  
  if (record.count >= RATE_LIMIT_MAX_REQUESTS) {
    return res.status(429).json({ error: 'Muitas requisições. Tente novamente mais tarde.' });
  }
  
  record.count++;
  rateLimitMap.set(ip, record);
  next();
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const name = `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`;
    cb(null, name);
  }
});

const fileFilter = (req, file, cb) => {
  const allowed = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'audio/webm', 'audio/mp3', 'audio/wav', 'audio/ogg', 'audio/mpeg'];
  if (allowed.includes(file.mimetype)) cb(null, true);
  else cb(new Error('Tipo de arquivo não permitido'), false);
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 25 * 1024 * 1024 }
});

function generateRandomSecret() {
  const crypto = require('crypto');
  return crypto.randomBytes(32).toString('hex');
}

function dbGet(sql, params) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => err ? reject(err) : resolve(row));
  });
}

function dbAll(sql, params) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows));
  });
}

function dbRun(sql, params) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function(err) {
      err ? reject(err) : resolve({ lastInsertRowid: this.lastID, changes: this.changes });
    });
  });
}

async function getReactionsFor(messageId) {
  const rows = await dbAll(`SELECT r.*, u.username FROM reactions r JOIN users u ON r.user_id = u.id WHERE r.message_id = ?`, [messageId]);
  return rows.map(r => ({ emoji: r.emoji, user_id: r.user_id, username: r.username }));
}

async function getMessageById(id) {
  const message = await dbGet(`SELECT m.*, u.username as sender_name, u.avatar_url as sender_avatar FROM messages m JOIN users u ON m.sender_id = u.id WHERE m.id = ?`, [id]);
  if (!message) return null;
  message.reactions = await getReactionsFor(id);
  return message;
}

async function assertValidReplyTo(replyToId, senderId, recipientId) {
  if (!replyToId) return null;
  const reference = await dbGet('SELECT sender_id, recipient_id FROM messages WHERE id = ?', [replyToId]);
  const participants = reference ? [reference.sender_id, reference.recipient_id] : [];
  if (!participants.includes(senderId) || !participants.includes(Number(recipientId))) {
    return { error: 'Mensagem de referência inválida' };
  }
  return null;
}

app.use(express.json());
app.use('/uploads', express.static(uploadsDir));
app.use(express.static(path.join(__dirname, 'public'), {
  etag: true,
  lastModified: true,
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
}));
const sessionMiddleware = session({
  secret: process.env.SESSION_SECRET || generateRandomSecret(),
  resave: false,
  saveUninitialized: false,
  cookie: { secure: process.env.NODE_ENV === 'production', maxAge: 24 * 60 * 60 * 1000 }
});

app.use(sessionMiddleware);
app.use(rateLimiter);

function authenticate(req, res, next) {
  if (req.session.userId) next();
  else res.status(401).json({ error: 'Não autenticado' });
}

app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const user = await dbGet('SELECT * FROM users WHERE username = ?', [username]);
    if (!user || !bcrypt.compareSync(password, user.password_hash)) {
      return res.status(401).json({ error: 'Usuário ou senha inválidos' });
    }
    req.session.userId = user.id;
    req.session.username = user.username;
    res.json({ success: true, user: { id: user.id, username: user.username, avatar_url: user.avatar_url, theme: user.theme } });
  } catch (e) {
    res.status(500).json({ error: 'Erro interno' });
  }
});

app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

app.get('/api/me', authenticate, async (req, res) => {
  try {
    const user = await dbGet('SELECT id, username, avatar_url, theme FROM users WHERE id = ?', [req.session.userId]);
    res.json({ user });
  } catch (e) {
    res.status(500).json({ error: 'Erro interno' });
  }
});

app.patch('/api/me', authenticate, async (req, res) => {
  try {
    const { theme, avatar_url } = req.body;
    const updates = [];
    const params = [];
    if (theme) { updates.push('theme = ?'); params.push(theme); }
    if (avatar_url) { updates.push('avatar_url = ?'); params.push(avatar_url); }
    if (updates.length) {
      params.push(req.session.userId);
      await dbRun(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`, params);
    }
    const user = await dbGet('SELECT id, username, avatar_url, theme FROM users WHERE id = ?', [req.session.userId]);
    res.json({ user });
  } catch (e) {
    res.status(500).json({ error: 'Erro interno' });
  }
});

app.get('/api/users', authenticate, async (req, res) => {
  try {
    const users = await dbAll('SELECT id, username, avatar_url FROM users WHERE id != ?', [req.session.userId]);
    res.json({ users });
  } catch (e) {
    res.status(500).json({ error: 'Erro interno' });
  }
});

app.get('/api/messages/:otherUserId', authenticate, async (req, res, next) => {
  try {
    const { otherUserId } = req.params;
    if (!/^\d+$/.test(otherUserId)) return next();
    const myId = req.session.userId;

    let limit = parseInt(req.query.limit, 10);
    if (!Number.isFinite(limit) || limit < 1) limit = 50;
    limit = Math.min(limit, 200);

    const params = [myId, otherUserId, otherUserId, myId, myId];
    let query = `
      SELECT m.*, u.username as sender_name, u.avatar_url as sender_avatar
      FROM messages m
      JOIN users u ON m.sender_id = u.id
      WHERE ((m.sender_id = ? AND m.recipient_id = ?) OR (m.sender_id = ? AND m.recipient_id = ?))
        AND NOT EXISTS (SELECT 1 FROM message_deletions d WHERE d.message_id = m.id AND d.user_id = ?)`;

    if (req.query.before !== undefined && req.query.before !== null && req.query.before !== '') {
      const before = parseInt(req.query.before, 10);
      if (!Number.isFinite(before)) return res.status(400).json({ error: 'Parâmetro before inválido' });
      query += ' AND m.id < ?';
      params.push(before);
    }

    query += ' ORDER BY m.created_at DESC, m.id DESC LIMIT ?';
    params.push(limit);

    const messages = (await dbAll(query, params)).reverse();

    const messageIds = messages.map(m => m.id);
    let reactions = [];
    if (messageIds.length) {
      const placeholders = messageIds.map(() => '?').join(',');
      reactions = await dbAll(`
        SELECT r.*, u.username
        FROM reactions r
        JOIN users u ON r.user_id = u.id
        WHERE r.message_id IN (${placeholders})
      `, messageIds);
    }

    const reactionsByMsg = {};
    for (const r of reactions) {
      if (!reactionsByMsg[r.message_id]) reactionsByMsg[r.message_id] = [];
      reactionsByMsg[r.message_id].push({ emoji: r.emoji, user_id: r.user_id, username: r.username });
    }

    const messagesWithReactions = messages.map(m => ({
      ...m,
      reactions: reactionsByMsg[m.id] || []
    }));

    res.json({ messages: messagesWithReactions });
  } catch (e) {
    res.status(500).json({ error: 'Erro interno' });
  }
});

app.post('/api/messages', authenticate, async (req, res) => {
  try {
    const { recipientId, content, type = 'text', replyToId } = req.body;
    const senderId = req.session.userId;

    if (type === 'text' && (!content || !content.trim())) {
      return res.status(400).json({ error: 'Mensagem vazia' });
    }

    if (!recipientId || Number(recipientId) === senderId) {
      return res.status(400).json({ error: 'Destinatário inválido' });
    }

    const recipient = await dbGet('SELECT id FROM users WHERE id = ?', [recipientId]);
    if (!recipient) return res.status(400).json({ error: 'Destinatário não encontrado' });

    const replyError = await assertValidReplyTo(replyToId, senderId, recipientId);
    if (replyError) return res.status(400).json(replyError);

    const result = await dbRun(
      `INSERT INTO messages (sender_id, recipient_id, type, content, reply_to_id) VALUES (?, ?, ?, ?, ?)`,
      [senderId, recipientId, type, content?.trim() || '', replyToId || null]
    );

    const message = await getMessageById(result.lastInsertRowid);

    broadcastToConversation(senderId, recipient.id, { type: 'new_message', message });

    res.json({ success: true, message });
  } catch (e) {
    res.status(500).json({ error: 'Erro interno' });
  }
});

function runUpload(req, res) {
  return new Promise((resolve, reject) => {
    upload.single('file')(req, res, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

app.post('/api/messages/media', authenticate, async (req, res) => {
  try {
    const senderId = req.session.userId;

    try {
      await runUpload(req, res);
    } catch (uploadErr) {
      if (uploadErr instanceof multer.MulterError && uploadErr.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ error: 'Arquivo muito grande (máx 25MB)' });
      }
      return res.status(415).json({ error: uploadErr.message || 'Tipo de arquivo não permitido' });
    }

    const { recipientId, type, replyToId } = req.body;
    const file = req.file;
    if (!file) return res.status(400).json({ error: 'Arquivo não enviado' });

    if (!recipientId || Number(recipientId) === senderId) {
      return res.status(400).json({ error: 'Destinatário inválido' });
    }

    const recipient = await dbGet('SELECT id FROM users WHERE id = ?', [recipientId]);
    if (!recipient) return res.status(400).json({ error: 'Destinatário não encontrado' });

    const replyError = await assertValidReplyTo(replyToId, senderId, recipientId);
    if (replyError) return res.status(400).json(replyError);

    let messageType = type || (file.mimetype.startsWith('image/') ? 'image' : 'audio');
    let content = '';
    let duration = null;

    if (messageType === 'audio' && file.mimetype.startsWith('audio/')) {
      content = 'Mensagem de áudio';
    } else if (messageType === 'image') {
      content = 'Imagem';
    }

    const result = await dbRun(
      `INSERT INTO messages (sender_id, recipient_id, type, content, media_url, media_name, media_size, media_duration, reply_to_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [senderId, recipientId, messageType, content, `/uploads/${file.filename}`, file.originalname, file.size, duration, replyToId || null]
    );

    const message = await getMessageById(result.lastInsertRowid);

    broadcastToConversation(senderId, recipient.id, { type: 'new_message', message });

    res.json({ success: true, message });
  } catch (e) {
    console.error('Media upload error:', e);
    res.status(500).json({ error: 'Erro ao enviar mídia' });
  }
});

app.patch('/api/messages/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const { content } = req.body;
    const userId = req.session.userId;

    const message = await dbGet('SELECT * FROM messages WHERE id = ?', [id]);
    if (!message) return res.status(404).json({ error: 'Mensagem não encontrada' });
    if (message.sender_id !== userId) return res.status(403).json({ error: 'Não autorizado' });
    if (message.deleted_at) return res.status(400).json({ error: 'Mensagem deletada' });

    if (!content || !content.trim()) {
      return res.status(400).json({ error: 'Conteúdo vazio' });
    }

    await dbRun('UPDATE messages SET content = ?, edited_at = CURRENT_TIMESTAMP WHERE id = ?', [content.trim(), id]);

    const updated = await getMessageById(id);

    broadcastToConversation(message.sender_id, message.recipient_id, { type: 'message_updated', message: updated });

    res.json({ success: true, message: updated });
  } catch (e) {
    res.status(500).json({ error: 'Erro interno' });
  }
});

app.delete('/api/messages/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const { forEveryone } = req.body;
    const userId = req.session.userId;

    const message = await dbGet('SELECT * FROM messages WHERE id = ?', [id]);
    if (!message) return res.status(404).json({ error: 'Mensagem não encontrada' });
    if (message.sender_id !== userId) return res.status(403).json({ error: 'Não autorizado' });

    if (forEveryone) {
      await dbRun(`UPDATE messages SET deleted_at = CURRENT_TIMESTAMP, deleted_for_everyone = 1, content = 'Esta mensagem foi apagada' WHERE id = ?`, [id]);
      broadcastToUser(message.recipient_id, { type: 'message_deleted', messageId: parseInt(id), forEveryone: true });
    } else {
      await dbRun('INSERT OR IGNORE INTO message_deletions (message_id, user_id) VALUES (?, ?)', [id, userId]);
    }

    broadcastToUser(userId, { type: 'message_deleted', messageId: parseInt(id), forEveryone: !!forEveryone });

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'Erro interno' });
  }
});

app.post('/api/messages/:id/reactions', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const { emoji } = req.body;
    const userId = req.session.userId;

    const message = await dbGet('SELECT * FROM messages WHERE id = ?', [id]);
    if (!message) return res.status(404).json({ error: 'Mensagem não encontrada' });

    await dbRun('INSERT OR IGNORE INTO reactions (message_id, user_id, emoji) VALUES (?, ?, ?)', [id, userId, emoji]);

    const formatted = await getReactionsFor(id);

    broadcastToConversation(message.sender_id, message.recipient_id, { type: 'reactions_updated', messageId: parseInt(id), reactions: formatted });

    res.json({ success: true, reactions: formatted });
  } catch (e) {
    res.status(500).json({ error: 'Erro interno' });
  }
});

app.delete('/api/messages/:id/reactions/:emoji', authenticate, async (req, res) => {
  try {
    const { id, emoji } = req.params;
    const userId = req.session.userId;

    const message = await dbGet('SELECT * FROM messages WHERE id = ?', [id]);
    if (!message) return res.status(404).json({ error: 'Mensagem não encontrada' });

    await dbRun('DELETE FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?', [id, userId, emoji]);

    const formatted = await getReactionsFor(id);

    broadcastToConversation(message.sender_id, message.recipient_id, { type: 'reactions_updated', messageId: parseInt(id), reactions: formatted });

    res.json({ success: true, reactions: formatted });
  } catch (e) {
    res.status(500).json({ error: 'Erro interno' });
  }
});

app.post('/api/audio-duration', authenticate, async (req, res) => {
  try {
    const { messageId, duration } = req.body;
    const userId = req.session.userId;

    const message = await dbGet('SELECT * FROM messages WHERE id = ?', [messageId]);
    if (!message || message.sender_id !== userId) return res.status(403).json({ error: 'Não autorizado' });

    await dbRun('UPDATE messages SET media_duration = ? WHERE id = ?', [duration, messageId]);

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'Erro interno' });
  }
});

// Message search endpoint
app.get('/api/messages/search', authenticate, async (req, res) => {
  try {
    const { query, limit = 20 } = req.query;
    const userId = req.session.userId;
    
    if (!query || !query.trim()) {
      return res.status(400).json({ error: 'Query vazia' });
    }

    const searchTerm = `%${query}%`;
    const messages = await dbAll(
      `SELECT m.*, u.username as sender_name, u.avatar_url as sender_avatar
       FROM messages m
       JOIN users u ON m.sender_id = u.id
       WHERE (m.sender_id = ? OR m.recipient_id = ?) AND m.content LIKE ? AND m.deleted_at IS NULL
       ORDER BY m.created_at DESC
       LIMIT ?`,
      [userId, userId, searchTerm, Math.min(limit, 50)]
    );

    res.json({ messages });
  } catch (e) {
    logger.error('Search error', { error: e.message });
    res.status(500).json({ error: 'Erro interno' });
  }
});

// Read receipt - mark message as read
app.post('/api/messages/:id/read', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.session.userId;

    const message = await dbGet('SELECT * FROM messages WHERE id = ?', [id]);
    if (!message) return res.status(404).json({ error: 'Mensagem não encontrada' });
    if (message.recipient_id !== userId) return res.status(403).json({ error: 'Não autorizado' });
    if (message.read_at) return res.json({ success: true });

    await dbRun('UPDATE messages SET read_at = CURRENT_TIMESTAMP WHERE id = ?', [id]);

    if (message.sender_id !== userId) {
      broadcastToUser(message.sender_id, { type: 'message_read', messageId: parseInt(id), readerId: userId });
    }

    res.json({ success: true });
  } catch (e) {
    logger.error('Read receipt error', { error: e.message });
    res.status(500).json({ error: 'Erro interno' });
  }
});

// Mark all messages in conversation as read
app.post('/api/conversations/:otherUserId/read', authenticate, async (req, res) => {
  try {
    const { otherUserId } = req.params;
    const userId = req.session.userId;

    await dbRun(
      `UPDATE messages SET read_at = CURRENT_TIMESTAMP 
       WHERE recipient_id = ? AND sender_id = ? AND read_at IS NULL AND deleted_at IS NULL`,
      [userId, otherUserId]
    );

    broadcastToUser(otherUserId, { type: 'conversation_read', readerId: userId });

    res.json({ success: true });
  } catch (e) {
    logger.error('Conversation read error', { error: e.message });
    res.status(500).json({ error: 'Erro interno' });
  }
});

// Pin/unpin message
app.post('/api/messages/:id/pin', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.session.userId;

    const message = await dbGet('SELECT * FROM messages WHERE id = ?', [id]);
    if (!message) return res.status(404).json({ error: 'Mensagem não encontrada' });
    if (message.sender_id !== userId && message.recipient_id !== userId) return res.status(403).json({ error: 'Não autorizado' });

    await dbRun('UPDATE messages SET is_pinned = 1 WHERE id = ?', [id]);

    broadcastToConversation(message.sender_id, message.recipient_id, { type: 'message_pinned', messageId: parseInt(id) });

    res.json({ success: true });
  } catch (e) {
    logger.error('Pin message error', { error: e.message });
    res.status(500).json({ error: 'Erro interno' });
  }
});

app.delete('/api/messages/:id/pin', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.session.userId;

    const message = await dbGet('SELECT * FROM messages WHERE id = ?', [id]);
    if (!message) return res.status(404).json({ error: 'Mensagem não encontrada' });
    if (message.sender_id !== userId && message.recipient_id !== userId) return res.status(403).json({ error: 'Não autorizado' });

    await dbRun('UPDATE messages SET is_pinned = 0 WHERE id = ?', [id]);

    res.json({ success: true });
  } catch (e) {
    logger.error('Unpin message error', { error: e.message });
    res.status(500).json({ error: 'Erro interno' });
  }
});

// Get pinned messages in conversation
app.get('/api/messages/:otherUserId/pinned', authenticate, async (req, res) => {
  try {
    const { otherUserId } = req.params;
    const userId = req.session.userId;

    const messages = await dbAll(
      `SELECT m.*, u.username as sender_name, u.avatar_url as sender_avatar
       FROM messages m
       JOIN users u ON m.sender_id = u.id
       WHERE ((m.sender_id = ? AND m.recipient_id = ?) OR (m.sender_id = ? AND m.recipient_id = ?))
         AND m.is_pinned = 1 AND m.deleted_at IS NULL
       ORDER BY m.created_at DESC`,
      [userId, otherUserId, otherUserId, userId]
    );

    res.json({ messages });
  } catch (e) {
    logger.error('Get pinned messages error', { error: e.message });
    res.status(500).json({ error: 'Erro interno' });
  }
});

// Update message with edit history
app.patch('/api/messages/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const { content } = req.body;
    const userId = req.session.userId;

    const message = await dbGet('SELECT * FROM messages WHERE id = ?', [id]);
    if (!message) return res.status(404).json({ error: 'Mensagem não encontrada' });
    if (message.sender_id !== userId) return res.status(403).json({ error: 'Não autorizado' });
    if (message.deleted_at) return res.status(400).json({ error: 'Mensagem deletada' });

    if (!content || !content.trim()) {
      return res.status(400).json({ error: 'Conteúdo vazio' });
    }

    const newContent = content.trim();
    const editHistory = message.edit_history 
      ? JSON.parse(message.edit_history) 
      : [];
    
    editHistory.push({
      content: message.content,
      editedAt: message.edited_at || null,
      editorId: userId
    });

    await dbRun(
      'UPDATE messages SET content = ?, edited_at = CURRENT_TIMESTAMP, edit_history = ? WHERE id = ?',
      [newContent, JSON.stringify(editHistory), id]
    );

    const updated = await getMessageById(id);

    broadcastToConversation(message.sender_id, message.recipient_id, { type: 'message_updated', message: updated });

    res.json({ success: true, message: updated });
  } catch (e) {
    logger.error('Edit message error', { error: e.message });
    res.status(500).json({ error: 'Erro interno' });
  }
});

const clients = new Map();

function broadcastToUser(userId, data) {
  const userClients = clients.get(userId);
  if (userClients) {
    const message = JSON.stringify(data);
    for (const client of userClients) {
      if (client.readyState === 1) client.send(message);
    }
  }
}

function broadcastToConversation(userId1, userId2, data) {
  broadcastToUser(userId1, data);
  broadcastToUser(userId2, data);
}

// Get online users
app.get('/api/users/online', authenticate, async (req, res) => {
  try {
    const userId = req.session.userId;
    const users = await dbAll(
      `SELECT u.id, u.username, u.avatar_url, p.status, p.last_seen
       FROM users u
       LEFT JOIN user_presence p ON u.id = p.user_id
       WHERE u.id != ?`,
      [userId]
    );
    
    res.json({ users: users.map(u => ({
      ...u,
      status: u.status || 'offline',
      last_seen: u.last_seen || null
    })) });
  } catch (e) {
    logger.error('Get online users error', { error: e.message });
    res.status(500).json({ error: 'Erro interno' });
  }
});

// Add after the broadcastToConversation function
function handleWsMessage(userId, ws, data) {
  if (!userId) return;
  
  switch (data.type) {
    case 'typing_start': {
      const { recipientId } = data;
      broadcastToUser(recipientId, { 
        type: 'typing_update', 
        userId, 
        status: 'typing',
        recipientId 
      });
      
      // Update typing status in presence table
      dbRun(
        `INSERT OR REPLACE INTO user_presence (user_id, status, typing_to, last_seen) 
         VALUES (?, 'typing', ?, CURRENT_TIMESTAMP)`,
        [userId, recipientId]
      );
      break;
    }
      
    case 'typing_stop': {
      const { recipientId } = data;
      broadcastToUser(recipientId, { 
        type: 'typing_update', 
        userId, 
        status: 'online',
        recipientId
      });
      
      // Reset typing status
      dbRun(
        `UPDATE user_presence SET status = 'online', typing_to = NULL, last_seen = CURRENT_TIMESTAMP 
         WHERE user_id = ?`,
        [userId]
      );
      break;
    }
  }
}

wss.on('connection', (ws, req) => {
  let userId = null;

  sessionMiddleware(req, {}, () => {
    userId = req.session && req.session.userId;
    if (userId) {
      if (!clients.has(userId)) clients.set(userId, new Set());
      clients.get(userId).add(ws);
      
      // Update presence to online
      dbRun(
        `INSERT OR REPLACE INTO user_presence (user_id, status, last_seen) 
         VALUES (?, 'online', CURRENT_TIMESTAMP)`,
        [userId]
      );
      
      // Notify others that user is online
      broadcastToUser(userId, { type: 'presence_update', userId, status: 'online' });
      
      ws.send(JSON.stringify({ type: 'auth_ok' }));
    } else {
      ws.close();
    }
  });

  // Heartbeat
  const heartbeatInterval = setInterval(() => {
    if (ws.readyState === ws.OPEN) {
      ws.ping();
    } else {
      clearInterval(heartbeatInterval);
    }
  }, 30000);

  ws.on('pong', () => {
    // Update last seen on pong
    if (userId) {
      dbRun(
        `UPDATE user_presence SET last_seen = CURRENT_TIMESTAMP WHERE user_id = ?`,
        [userId]
      );
    }
  });

  ws.on('message', (data) => {
    try {
      const message = JSON.parse(data);
      handleWsMessage(userId, ws, message);
    } catch (e) {
      logger.error('WebSocket message error', { error: e.message });
      ws.close();
    }
  });

  ws.on('close', () => {
    if (userId && clients.has(userId)) {
      const userClients = clients.get(userId);
      userClients.delete(ws);
      if (userClients.size === 0) {
        clients.delete(userId);
        // Update presence to offline
        dbRun(
          `UPDATE user_presence SET status = 'offline', last_seen = CURRENT_TIMESTAMP 
           WHERE user_id = ?`,
          [userId]
        );
        // Notify others that user is offline
        broadcastToUser(userId, { type: 'presence_update', userId, status: 'offline' });
      }
    }
  });
});

app.use((req, res) => {
  if (!req.path.startsWith('/api/')) {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  } else {
    res.status(404).json({ error: 'Não encontrado' });
  }
});
const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  logger.info(`Servidor rodando em http://localhost:${PORT}`);
  logger.info('Usuários: mateus / 01850309  |  debora / 23092025');
});
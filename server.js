const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const sqlite3 = require('sqlite3').verbose();
const { WebSocketServer } = require('ws');
const http = require('http');
const path = require('path');
const multer = require('multer');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const dbPath = path.join(__dirname, 'chat.db');
const db = new sqlite3.Database(dbPath);

const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
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

app.use(express.json());
app.use('/uploads', express.static(uploadsDir));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: 'private-chat-secret-key-2026',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 }
}));

function handleUploadErrors(err, req, res, next) {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: 'Arquivo muito grande (máx 25MB)' });
    }
    return res.status(400).json({ error: `Erro no upload: ${err.message}` });
  }
  if (err) {
    return res.status(415).json({ error: err.message || 'Tipo de arquivo não permitido' });
  }
  next();
}

app.use(handleUploadErrors);

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

app.get('/api/messages/:otherUserId', authenticate, async (req, res) => {
  try {
    const { otherUserId } = req.params;
    const myId = req.session.userId;
    const messages = await dbAll(`
      SELECT m.*, u.username as sender_name, u.avatar_url as sender_avatar
      FROM messages m
      JOIN users u ON m.sender_id = u.id
      WHERE ((m.sender_id = ? AND m.recipient_id = ?) OR (m.sender_id = ? AND m.recipient_id = ?))
        AND m.deleted_at IS NULL
      ORDER BY m.created_at ASC
    `, [myId, otherUserId, otherUserId, myId]);

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

    const result = await dbRun(
      `INSERT INTO messages (sender_id, recipient_id, type, content, reply_to_id) VALUES (?, ?, ?, ?, ?)`,
      [senderId, recipientId, type, content?.trim() || '', replyToId || null]
    );

    const message = await dbGet(`
      SELECT m.*, u.username as sender_name, u.avatar_url as sender_avatar
      FROM messages m
      JOIN users u ON m.sender_id = u.id
      WHERE m.id = ?
    `, [result.lastInsertRowid]);

    message.reactions = [];
    broadcastToUser(recipientId, { type: 'new_message', message });
    broadcastToUser(senderId, { type: 'new_message', message });

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

    const message = await dbGet(`
      SELECT m.*, u.username as sender_name, u.avatar_url as sender_avatar
      FROM messages m
      JOIN users u ON m.sender_id = u.id
      WHERE m.id = ?
    `, [result.lastInsertRowid]);

    message.reactions = [];
    broadcastToUser(recipientId, { type: 'new_message', message });
    broadcastToUser(senderId, { type: 'new_message', message });

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

    await dbRun('UPDATE messages SET content = ?, edited_at = CURRENT_TIMESTAMP WHERE id = ?', [content.trim(), id]);

    const updated = await dbGet(`
      SELECT m.*, u.username as sender_name, u.avatar_url as sender_avatar
      FROM messages m
      JOIN users u ON m.sender_id = u.id
      WHERE m.id = ?
    `, [id]);

    broadcastToUser(message.recipient_id, { type: 'message_updated', message: updated });
    broadcastToUser(userId, { type: 'message_updated', message: updated });

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
      await dbRun('UPDATE messages SET deleted_at = CURRENT_TIMESTAMP, deleted_for_everyone = 1, content = "Esta mensagem foi apagada" WHERE id = ?', [id]);
    } else {
      await dbRun('UPDATE messages SET deleted_at = CURRENT_TIMESTAMP WHERE id = ?', [id]);
    }

    broadcastToUser(message.recipient_id, { type: 'message_deleted', messageId: parseInt(id), forEveryone: !!forEveryone });
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

    const reactions = await dbAll(`
      SELECT r.*, u.username
      FROM reactions r
      JOIN users u ON r.user_id = u.id
      WHERE r.message_id = ?
    `, [id]);

    const formatted = reactions.map(r => ({ emoji: r.emoji, user_id: r.user_id, username: r.username }));

    broadcastToUser(message.sender_id, { type: 'reactions_updated', messageId: parseInt(id), reactions: formatted });
    broadcastToUser(message.recipient_id, { type: 'reactions_updated', messageId: parseInt(id), reactions: formatted });

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

    const reactions = await dbAll(`
      SELECT r.*, u.username
      FROM reactions r
      JOIN users u ON r.user_id = u.id
      WHERE r.message_id = ?
    `, [id]);

    const formatted = reactions.map(r => ({ emoji: r.emoji, user_id: r.user_id, username: r.username }));

    broadcastToUser(message.sender_id, { type: 'reactions_updated', messageId: parseInt(id), reactions: formatted });
    broadcastToUser(message.recipient_id, { type: 'reactions_updated', messageId: parseInt(id), reactions: formatted });

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

wss.on('connection', (ws, req) => {
  let userId = null;
  
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      if (msg.type === 'auth' && msg.userId) {
        userId = msg.userId;
        if (!clients.has(userId)) clients.set(userId, new Set());
        clients.get(userId).add(ws);
        ws.send(JSON.stringify({ type: 'auth_ok' }));
      }
    } catch (e) {
      console.error('WebSocket message error:', e);
    }
  });
  
  ws.on('close', () => {
    if (userId && clients.has(userId)) {
      const userClients = clients.get(userId);
      userClients.delete(ws);
      if (userClients.size === 0) clients.delete(userId);
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

const PORT = 3000;
server.listen(PORT, () => {
  console.log(`Servidor rodando em http://localhost:${PORT}`);
  console.log('Usuários: mateus / 01850309  |  debora / 23092025');
});
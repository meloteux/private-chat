const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const sqlite3 = require('sqlite3').verbose();
const { WebSocketServer } = require('ws');
const http = require('http');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const dbPath = path.join(__dirname, 'chat.db');
const db = new sqlite3.Database(dbPath);

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
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: 'private-chat-secret-key-2026',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 }
}));

function authenticate(req, res, next) {
  if (req.session.userId) {
    next();
  } else {
    res.status(401).json({ error: 'Não autenticado' });
  }
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
    
    res.json({ 
      success: true, 
      user: { id: user.id, username: user.username } 
    });
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
    const user = await dbGet('SELECT id, username FROM users WHERE id = ?', [req.session.userId]);
    res.json({ user });
  } catch (e) {
    res.status(500).json({ error: 'Erro interno' });
  }
});

app.get('/api/users', authenticate, async (req, res) => {
  try {
    const users = await dbAll('SELECT id, username FROM users WHERE id != ?', [req.session.userId]);
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
      SELECT m.*, u.username as sender_name
      FROM messages m
      JOIN users u ON m.sender_id = u.id
      WHERE (m.sender_id = ? AND m.recipient_id = ?)
         OR (m.sender_id = ? AND m.recipient_id = ?)
      ORDER BY m.created_at ASC
    `, [myId, otherUserId, otherUserId, myId]);
    
    res.json({ messages });
  } catch (e) {
    res.status(500).json({ error: 'Erro interno' });
  }
});

app.post('/api/messages', authenticate, async (req, res) => {
  try {
    const { recipientId, content } = req.body;
    const senderId = req.session.userId;
    
    if (!content || !content.trim()) {
      return res.status(400).json({ error: 'Mensagem vazia' });
    }
    
    const result = await dbRun(
      'INSERT INTO messages (sender_id, recipient_id, content) VALUES (?, ?, ?)',
      [senderId, recipientId, content.trim()]
    );
    
    const message = await dbGet(`
      SELECT m.*, u.username as sender_name
      FROM messages m
      JOIN users u ON m.sender_id = u.id
      WHERE m.id = ?
    `, [result.lastInsertRowid]);
    
    broadcastToUser(recipientId, { type: 'new_message', message });
    broadcastToUser(senderId, { type: 'new_message', message });
    
    res.json({ success: true, message });
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
      if (client.readyState === 1) {
        client.send(message);
      }
    }
  }
}

wss.on('connection', (ws, req) => {
  let userId = null;
  
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      
      if (msg.type === 'auth' && msg.userId) {
        userId = msg.userId;
        if (!clients.has(userId)) {
          clients.set(userId, new Set());
        }
        clients.get(userId).add(ws);
      }
    } catch (e) {
      console.error('WebSocket message error:', e);
    }
  });
  
  ws.on('close', () => {
    if (userId && clients.has(userId)) {
      const userClients = clients.get(userId);
      userClients.delete(ws);
      if (userClients.size === 0) {
        clients.delete(userId);
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

const PORT = 3000;
server.listen(PORT, () => {
  console.log(`Servidor rodando em http://localhost:${PORT}`);
  console.log('Usuários: mateus / 01850309  |  debora / 23092025');
});
# Chat Privado

Chat privado para duas pessoas, com mensagens guardadas em banco de dados local (SQLite).

Cada um entra na própria conta. Só esses dois conseguem acessar.

## Como rodar

```bash
# instalar dependências
npm install

# criar o banco e os usuários (rode sempre que atualizar)
node init-db.js

# iniciar o servidor
node server.js
```

Acesse: **http://localhost:3000**

## Funcionalidades (P0)

- Login com senha criptografada (bcrypt) e sessão
- Chat em tempo real via WebSocket
- Envio de imagens (JPG, PNG, GIF, WEBP) - clique no clipe 📎
- Mensagens de áudio - clique no microfone 🎤
- Editar mensagem (clique direito → Editar)
- Apagar para mim / Apagar para todos (clique direito)
- Reações com emoji (clique na mensagem)
- Responder mensagem (clique direito → Responder)
- Tema claro / escuro (botão no canto superior)
- Indicador de "editado"
- Interface responsiva (celular, tablet, desktop)
- Limite de upload: 25MB por arquivo

## Armazenamento

O banco fica em `chat.db` (SQLite) na pasta do projeto. As mídias vão para a pasta `uploads/`.

## Segurança

- Senhas com hash bcrypt
- Sessões com cookie httpOnly
- Tipos de arquivo validados no servidor
- Limite de tamanho de upload

## Estrutura

```
private-chat/
├── server.js          # Backend Express + WebSocket
├── init-db.js         # Criação do banco + migrações
├── package.json
├── public/
│   ├── index.html     # Interface
│   ├── style.css      # Estilos (tema claro/escuro)
│   └── app.js         # Lógica do frontend
└── uploads/           # Imagens e áudios enviados
```

## API

| Método | Rota | Descrição |
|--------|------|-----------|
| POST | `/api/login` | Entrar |
| POST | `/api/logout` | Sair |
| GET | `/api/me` | Dados do usuário logado |
| PATCH | `/api/me` | Atualizar tema/avatar |
| GET | `/api/users` | Listar contatos |
| GET | `/api/messages/:id` | Histórico da conversa |
| POST | `/api/messages` | Enviar mensagem de texto |
| POST | `/api/messages/media` | Enviar imagem/áudio |
| PATCH | `/api/messages/:id` | Editar mensagem |
| DELETE | `/api/messages/:id` | Apagar mensagem |
| POST | `/api/messages/:id/reactions` | Adicionar reação |
| DELETE | `/api/messages/:id/reactions/:emoji` | Remover reação |
| POST | `/api/audio-duration` | Salvar duração do áudio |

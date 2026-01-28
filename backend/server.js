const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const path = require('path');
const { initDB } = require('./database');
const routes = require('./routes');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Initialize Database
initDB();

// Config
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '..'))); // Serve root (index.html)
app.use('/uploads', express.static(path.join(__dirname, 'uploads'))); // Serve media

// Session Setup
const sessionMiddleware = session({
    store: new SQLiteStore({ db: 'sessions.db', dir: path.join(__dirname) }),
    secret: 'litestream_secret_key_change_me',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 } // 1 week
});

app.use(sessionMiddleware);

// Share IO and Session with Routes
app.use((req, res, next) => {
    req.io = io;
    next();
});

// Socket.io Session sharing (Optional for now, but good practice)
io.engine.use(sessionMiddleware);

io.on('connection', (socket) => {
    const req = socket.request;
    if (req.session.userId) {
        socket.join(`user_${req.session.userId}`);
    }
});

// Routes
app.use('/api', routes);

// Start Server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`LiteStream running on port ${PORT}`);
    console.log(`Mode: Low-End VPS (1 vCPU Optimization Enabled)`);
});
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const bcrypt = require('bcrypt');
const fs = require('fs');

const dbPath = path.join(__dirname, 'litestream.sqlite');
const db = new sqlite3.Database(dbPath);

const initDB = () => {
    db.serialize(() => {
        // Users Table
        db.run(`CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE,
            password TEXT,
            role TEXT DEFAULT 'user',
            plan_id INTEGER,
            current_storage INTEGER DEFAULT 0
        )`);

        // Plans Table
        db.run(`CREATE TABLE IF NOT EXISTS plans (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT,
            max_storage INTEGER, -- in bytes
            max_stream_time INTEGER -- in minutes
        )`);

        // Media Table
        db.run(`CREATE TABLE IF NOT EXISTS media (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER,
            filename TEXT,
            path TEXT,
            type TEXT, -- video, audio, image
            size INTEGER,
            locked INTEGER DEFAULT 0,
            thumbnail_path TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(user_id) REFERENCES users(id)
        )`);

        // Seed Plans
        db.get("SELECT count(*) as count FROM plans", (err, row) => {
            if (row.count === 0) {
                db.run("INSERT INTO plans (name, max_storage, max_stream_time) VALUES (?, ?, ?)", ['Free', 1073741824, 60]); // 1GB
                db.run("INSERT INTO plans (name, max_storage, max_stream_time) VALUES (?, ?, ?)", ['Pro', 21474836480, 240]); // 20GB
            }
        });

        // Seed Admin (password: admin123)
        db.get("SELECT count(*) as count FROM users", (err, row) => {
            if (row.count === 0) {
                const hash = bcrypt.hashSync('admin123', 10);
                db.run("INSERT INTO users (username, password, role, plan_id) VALUES (?, ?, ?, ?)", ['admin', hash, 'admin', 2]);
            }
        });
    });
};

module.exports = { db, initDB };
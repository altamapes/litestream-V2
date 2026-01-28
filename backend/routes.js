const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const ffmpeg = require('fluent-ffmpeg');
const { db } = require('./database');
const streamEngine = require('./streamEngine');

// --- MIDDLEWARE ---
const isAuthenticated = (req, res, next) => {
    if (req.session.userId) return next();
    res.status(401).json({ error: 'Unauthorized' });
};

// --- STORAGE SETUP ---
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const dir = path.join(__dirname, 'uploads');
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + path.extname(file.originalname));
    }
});
const upload = multer({ storage: storage });

// --- AUTH ROUTES ---
router.post('/login', (req, res) => {
    const { username, password } = req.body;
    db.get("SELECT * FROM users WHERE username = ?", [username], (err, user) => {
        if (err || !user) return res.status(401).json({ error: 'Invalid credentials' });
        
        if (bcrypt.compareSync(password, user.password)) {
            req.session.userId = user.id;
            req.session.role = user.role;
            res.json({ success: true, user: { id: user.id, username: user.username, role: user.role } });
        } else {
            res.status(401).json({ error: 'Invalid credentials' });
        }
    });
});

router.post('/register', (req, res) => {
    const { username, password } = req.body;
    const hash = bcrypt.hashSync(password, 10);
    // Assign Plan ID 1 (Free) by default
    db.run("INSERT INTO users (username, password, plan_id) VALUES (?, ?, 1)", [username, hash], function(err) {
        if (err) return res.status(500).json({ error: 'Username exists or DB error' });
        res.json({ success: true });
    });
});

router.post('/logout', (req, res) => {
    req.session.destroy();
    res.json({ success: true });
});

router.get('/me', isAuthenticated, (req, res) => {
    db.get(`SELECT u.id, u.username, u.current_storage, p.max_storage, p.name as plan_name 
            FROM users u JOIN plans p ON u.plan_id = p.id WHERE u.id = ?`, [req.session.userId], (err, user) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(user);
    });
});

// --- MEDIA ROUTES ---
router.post('/upload', isAuthenticated, upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const ext = path.extname(req.file.originalname).toLowerCase();
    let type = 'unknown';
    if (['.mp4', '.mkv', '.mov'].includes(ext)) type = 'video';
    else if (['.mp3', '.wav', '.aac'].includes(ext)) type = 'audio';
    else if (['.jpg', '.png', '.jpeg'].includes(ext)) type = 'image';

    const userId = req.session.userId;
    const filePath = req.file.path;
    const fileSize = req.file.size;

    // Check quota
    db.get(`SELECT u.current_storage, p.max_storage FROM users u JOIN plans p ON u.plan_id = p.id WHERE u.id = ?`, [userId], (err, row) => {
        if (row.current_storage + fileSize > row.max_storage) {
            fs.unlinkSync(filePath); // Delete file
            return res.status(403).json({ error: 'Storage limit exceeded' });
        }

        // Generate Thumbnail for Video
        let thumbPath = null;
        const finalizeUpload = () => {
            db.run("INSERT INTO media (user_id, filename, path, type, size, thumbnail_path) VALUES (?, ?, ?, ?, ?, ?)",
                [userId, req.file.originalname, filePath, type, fileSize, thumbPath],
                function(err) {
                    if (err) return res.status(500).json({ error: err.message });
                    
                    // Update storage usage
                    db.run("UPDATE users SET current_storage = current_storage + ? WHERE id = ?", [fileSize, userId]);
                    res.json({ success: true, id: this.lastID });
                }
            );
        };

        if (type === 'video') {
            const thumbName = `thumb_${req.file.filename}.png`;
            thumbPath = path.join(__dirname, 'uploads', thumbName);
            ffmpeg(filePath)
                .screenshots({
                    count: 1,
                    folder: path.join(__dirname, 'uploads'),
                    filename: thumbName,
                    size: '320x?'
                })
                .on('end', finalizeUpload)
                .on('error', finalizeUpload); // Proceed even if thumb fails
        } else {
            finalizeUpload();
        }
    });
});

router.get('/media', isAuthenticated, (req, res) => {
    db.all("SELECT * FROM media WHERE user_id = ? ORDER BY created_at DESC", [req.session.userId], (err, rows) => {
        res.json(rows);
    });
});

router.delete('/media/:id', isAuthenticated, (req, res) => {
    const mediaId = req.params.id;
    db.get("SELECT * FROM media WHERE id = ? AND user_id = ?", [mediaId, req.session.userId], (err, row) => {
        if (!row) return res.status(404).json({ error: 'Not found' });
        if (row.locked) return res.status(403).json({ error: 'File is locked' });

        // Delete files
        if (fs.existsSync(row.path)) fs.unlinkSync(row.path);
        if (row.thumbnail_path && fs.existsSync(row.thumbnail_path)) fs.unlinkSync(row.thumbnail_path);

        db.run("DELETE FROM media WHERE id = ?", [mediaId], () => {
            db.run("UPDATE users SET current_storage = current_storage - ? WHERE id = ?", [row.size, req.session.userId]);
            res.json({ success: true });
        });
    });
});

router.post('/media/:id/toggle-lock', isAuthenticated, (req, res) => {
    db.run("UPDATE media SET locked = NOT locked WHERE id = ? AND user_id = ?", [req.params.id, req.session.userId], () => {
        res.json({ success: true });
    });
});

// --- STREAM ROUTES ---
router.post('/stream/start', isAuthenticated, async (req, res) => {
    const { rtmpUrl, mediaIds, coverImageId } = req.body;
    try {
        await streamEngine.startStream(req.session.userId, rtmpUrl, mediaIds, coverImageId, req.io);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

router.post('/stream/stop', isAuthenticated, (req, res) => {
    streamEngine.stopStream(req.session.userId);
    res.json({ success: true });
});

router.get('/stream/status', isAuthenticated, (req, res) => {
    res.json({ status: streamEngine.getStreamStatus(req.session.userId) });
});

module.exports = router;
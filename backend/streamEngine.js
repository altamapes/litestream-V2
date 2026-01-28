const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const path = require('path');
const { db } = require('./database');

// Track active streams: userId -> { command, pid }
const activeStreams = new Map();

// Helper to write playlist file for Concat Demuxer
const generatePlaylist = (userId, filePaths) => {
    const playlistPath = path.join(__dirname, 'uploads', `playlist_${userId}.txt`);
    const content = filePaths.map(p => `file '${p}'`).join('\n');
    fs.writeFileSync(playlistPath, content);
    return playlistPath;
};

const getMediaDetails = (mediaIds) => {
    return new Promise((resolve, reject) => {
        if (!mediaIds || mediaIds.length === 0) return resolve([]);
        const placeholders = mediaIds.map(() => '?').join(',');
        db.all(`SELECT * FROM media WHERE id IN (${placeholders}) ORDER BY CASE id ${mediaIds.map((id, i) => `WHEN ${id} THEN ${i}`).join(' ')} END`, mediaIds, (err, rows) => {
            if (err) reject(err);
            else resolve(rows);
        });
    });
};

const startStream = async (userId, rtmpUrl, mediaIds, coverImageId, io) => {
    if (activeStreams.has(userId)) {
        throw new Error("Stream already running. Stop it first.");
    }

    const mediaItems = await getMediaDetails(mediaIds);
    if (mediaItems.length === 0) throw new Error("No media selected.");

    const firstType = mediaItems[0].type;
    const playlistPath = generatePlaylist(userId, mediaItems.map(m => m.path));
    
    let command = ffmpeg();
    const logPrefix = `[User ${userId}]`;

    // --- STREAM LOGIC ---
    if (firstType === 'audio') {
        // Radio Mode
        if (!coverImageId) throw new Error("Cover image required for Audio mode.");
        const coverRows = await getMediaDetails([coverImageId]);
        const coverPath = coverRows[0].path;

        command
            .input(coverPath)
            .inputOptions(['-loop 1']) // Loop image
            .input(playlistPath)
            .inputOptions(['-f concat', '-safe 0']) // Concat Demuxer
            .outputOptions([
                '-map 0:v', '-map 1:a', // Video from image, Audio from playlist
                '-shortest', // Stop when audio ends
                '-pix_fmt yuv420p'
            ]);

    } else if (firstType === 'video') {
        // Video Mode
        command
            .input(playlistPath)
            .inputOptions(['-f concat', '-safe 0']);
    } else {
        throw new Error("Invalid media type for streaming.");
    }

    // --- LOW END VPS OPTIMIZATION FLAGS ---
    command
        .outputOptions([
            '-c:v libx264',
            '-preset ultrafast', // CRITICAL for 1 vCPU
            '-tune zerolatency', // For streaming
            '-r 24', // Low framerate saves CPU
            '-g 48', // Keyframe interval (2x fps)
            '-threads 1', // STRICT constraint
            '-b:v 1000k', // Bitrate limit
            '-maxrate 1000k',
            '-bufsize 2000k',
            '-s 1280x720', // Max resolution
            '-c:a aac',
            '-b:a 128k',
            '-ar 44100',
            '-f flv'
        ])
        .output(rtmpUrl)
        .on('start', (cmdLine) => {
            console.log(`${logPrefix} Started: ${cmdLine}`);
            io.to(`user_${userId}`).emit('stream:status', { status: 'live', log: 'Stream initialization...' });
            activeStreams.set(userId, { command, startTime: Date.now() });
        })
        .on('stderr', (stderrLine) => {
            // Send logs to frontend (debounced ideally, but raw here for simplicity)
            io.to(`user_${userId}`).emit('stream:log', stderrLine);
        })
        .on('error', (err) => {
            console.error(`${logPrefix} Error: ${err.message}`);
            io.to(`user_${userId}`).emit('stream:status', { status: 'error', log: err.message });
            activeStreams.delete(userId);
            // Cleanup playlist
            if (fs.existsSync(playlistPath)) fs.unlinkSync(playlistPath);
        })
        .on('end', () => {
            console.log(`${logPrefix} Finished.`);
            io.to(`user_${userId}`).emit('stream:status', { status: 'offline', log: 'Stream finished.' });
            activeStreams.delete(userId);
            if (fs.existsSync(playlistPath)) fs.unlinkSync(playlistPath);
        });

    command.run();
};

const stopStream = (userId) => {
    if (activeStreams.has(userId)) {
        const { command } = activeStreams.get(userId);
        try {
            command.kill('SIGKILL');
        } catch (e) {
            console.error("Error killing stream:", e);
        }
        activeStreams.delete(userId);
        return true;
    }
    return false;
};

const getStreamStatus = (userId) => {
    return activeStreams.has(userId) ? 'live' : 'offline';
};

module.exports = { startStream, stopStream, getStreamStatus };
require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const mysql = require('mysql2');
const mqtt = require('mqtt');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] }});

const db = mysql.createPool({
  host: 'byhkjuc1hiflmfwleeyu-mysql.services.clever-cloud.com',
  user: 'usf3wqqdmiygzglk',
  password: 'mcWjMPBLiLbzUcedABZv',
  database: 'byhkjuc1hiflmfwleeyu',
  port: 3306,
  waitForConnections: true,
  connectionLimit: 2,
  queueLimit: 0
});

// ==========================================
// KHU VỰC TỰ ĐỘNG XÂY DỰNG 6 BẢNG DATABASE (CHỐNG SẬP 100%)
// ==========================================

// 1. Bảng Phòng Thi (Thiếu cái này là mất hết lớp cũ)
db.query(`CREATE TABLE IF NOT EXISTS sessions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255),
  join_code VARCHAR(50)
)`);

// 2. Bảng Đề Thi 
db.query(`CREATE TABLE IF NOT EXISTS questions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  session_id INT,
  content TEXT,
  answer_a VARCHAR(255),
  answer_b VARCHAR(255),
  answer_c VARCHAR(255),
  answer_d VARCHAR(255),
  correct_answer VARCHAR(5)
)`);

// 3. Bảng lưu đáp án (Lịch sử làm bài)
db.query(`CREATE TABLE IF NOT EXISTS answers (
  id INT AUTO_INCREMENT PRIMARY KEY,
  session_id INT,
  question_index INT,
  player_name VARCHAR(255),
  source VARCHAR(50),
  is_correct BOOLEAN
)`);

// 4. Bảng nối dây phần cứng (Thiết bị 1 -> Tên)
db.query(`CREATE TABLE IF NOT EXISTS hardware_mappings (
  id INT AUTO_INCREMENT PRIMARY KEY,
  session_id INT,
  device_id INT,
  student_name VARCHAR(255)
)`);

// 5. Bảng Sổ đầu bài gốc 
db.query(`CREATE TABLE IF NOT EXISTS class_students (
  id INT AUTO_INCREMENT PRIMARY KEY,
  stt INT,
  full_name VARCHAR(255),
  dob VARCHAR(50)
)`);

// 6. Bảng Sảnh Chờ (Ai đã điểm danh)
db.query(`CREATE TABLE IF NOT EXISTS session_checkins (
  id INT AUTO_INCREMENT PRIMARY KEY,
  session_id INT,
  stt INT,
  full_name VARCHAR(255),
  source VARCHAR(50)
)`);

let currentLiveQuestion = null;
let currentQuestionIndex = 0;
let hardwareLobby = new Map();

const getHardwareLobby = () => Array.from(hardwareLobby.values()).sort((a, b) => a.device_id - b.device_id);

// ==========================================
// CÁC API PHÒNG THI & ĐỀ THI
// ==========================================
app.get('/api/sessions', (req, res) => {
  db.query("SELECT * FROM sessions ORDER BY id DESC", (err, r) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(r || []);
  });
});

app.post('/api/sessions', (req, res) => {
  db.query("INSERT INTO sessions (name, join_code) VALUES (?, ?)", [req.body.name, req.body.join_code], (err, r) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true, id: r.insertId });
  });
});

app.delete('/api/sessions/:id', (req, res) => {
  const sId = req.params.id;
  db.query("DELETE FROM hardware_mappings WHERE session_id = ?", [sId], () => {
    db.query("DELETE FROM session_checkins WHERE session_id = ?", [sId], () => {
      db.query("DELETE FROM answers WHERE session_id = ?", [sId], () => {
        db.query("DELETE FROM questions WHERE session_id = ?", [sId], () => {
          db.query("DELETE FROM sessions WHERE id = ?", [sId], (err) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true });
          });
        });
      });
    });
  });
});

app.get('/api/questions', (req, res) => {
  db.query("SELECT * FROM questions WHERE session_id = ?", [req.query.session_id || 1], (err, r) => res.json(r || []));
});

app.post('/api/questions/bulk', (req, res) => {
  const values = req.body.questions.map(q => [req.body.session_id, q.content, q.answer_a, q.answer_b, q.answer_c, q.answer_d, q.correct_answer]);
  if(values.length === 0) return res.json({ success: true });
  db.query("INSERT INTO questions (session_id, content, answer_a, answer_b, answer_c, answer_d, correct_answer) VALUES ?", [values], (err, r) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true, inserted: r.affectedRows });
  });
});

app.delete('/api/questions/clear', (req, res) => {
  db.query("DELETE FROM questions WHERE session_id = ?", [req.body.session_id], () => {
    db.query("DELETE FROM answers WHERE session_id = ?", [req.body.session_id], () => res.json({ success: true }));
  });
});

// ==========================================
// API THIẾT BỊ & LỊCH SỬ LÀM BÀI
// ==========================================
app.get('/api/hardware/mapping', (req, res) => {
  db.query("SELECT * FROM hardware_mappings WHERE session_id = ?", [req.query.session_id], (err, r) => res.json(r || []));
});

app.get('/api/hardware/lobby', (req, res) => {
  res.json({ devices: getHardwareLobby() });
});

app.post('/api/hardware/mapping', (req, res) => {
  const { session_id, mappings } = req.body;
  db.query("DELETE FROM hardware_mappings WHERE session_id = ?", [session_id], () => {
    if(mappings.length === 0) return res.json({ success: true });
    const values = mappings.map(m => [session_id, m.device_id, m.student_name]);
    db.query("INSERT INTO hardware_mappings (session_id, device_id, student_name) VALUES ?", [values], (err, r) => {
       if (err) return res.status(500).json({ error: err.message });
       res.json({ success: true, inserted: r.affectedRows });
    });
  });
});

app.get('/api/progress', (req, res) => {
  db.query("SELECT * FROM answers WHERE session_id = ?", [req.query.session_id], (err, r) => res.json(r || []));
});

app.delete('/api/progress/clear', (req, res) => {
  db.query("DELETE FROM answers WHERE session_id = ?", [req.body.session_id], (err) => {
    res.json({ success: true });
  });
});

// ==========================================
// API QUẢN LÝ DANH SÁCH GỐC & ĐIỂM DANH
// ==========================================
app.get('/api/students', (req, res) => {
  db.query("SELECT * FROM class_students ORDER BY stt ASC", (err, r) => res.json(r || []));
});

app.post('/api/students/upload', (req, res) => {
  const { students } = req.body; 
  db.query("DELETE FROM class_students", () => { 
    if (!students || students.length === 0) return res.json({ success: true });
    const values = students.map(s => [s.stt, s.full_name, s.dob]);
    db.query("INSERT INTO class_students (stt, full_name, dob) VALUES ?", [values], (err, r) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true, inserted: r.affectedRows });
    });
  });
});

app.get('/api/students/verify', (req, res) => {
  db.query("SELECT * FROM class_students WHERE stt = ?", [req.query.stt], (err, r) => {
    if (r && r.length > 0) res.json({ success: true, student: r[0] });
    else res.json({ success: false, message: "Không tìm thấy STT này trong danh sách lớp!" });
  });
});

app.post('/api/checkin', (req, res) => {
  const { session_id, stt, full_name, source } = req.body;
  db.query("SELECT * FROM session_checkins WHERE session_id = ? AND stt = ?", [session_id, stt], (err, r) => {
    if (r && r.length > 0) return res.json({ success: true }); 
    db.query("INSERT INTO session_checkins (session_id, stt, full_name, source) VALUES (?, ?, ?, ?)", 
      [session_id, stt, full_name, source], (err2) => {
        if (err2) return res.status(500).json({ error: err2.message });
        io.emit('admin_new_checkin', { stt, full_name, source });
        res.json({ success: true });
    });
  });
});

// ==========================================
// 📡 MẠNG LƯỚI SOCKET (WEB) & MQTT (PHẦN CỨNG)
// ==========================================
io.on('connection', (socket) => {
  socket.on('admin_send_action', (data) => {
    if (data.action === 'open_question') { currentLiveQuestion = data.questionData; currentQuestionIndex = data.questionIndex || 0; }
    io.emit('server_broadcast_action', data);
  });

  socket.on('player_submit_answer', (data) => {
    data.source = 'WEB';
    if (data.sessionId) {
      db.query("SELECT * FROM session_checkins WHERE session_id = ? AND full_name = ?", [data.sessionId, data.playerName], (err, r) => {
        if (r && r.length > 0) {
          db.query("INSERT INTO answers (session_id, question_index, player_name, source, is_correct) VALUES (?, ?, ?, ?, ?)",
            [data.sessionId, data.questionIndex, data.playerName, data.source, data.isCorrect], 
            (err) => {
              if (!err) {
                console.log(`✅ Web: [${data.playerName}] nộp Câu ${data.questionIndex + 1}`);
                io.emit('admin_track_progress', data);
              }
            });
        }
      });
    }
  });
});

const mqttClient = mqtt.connect('mqtt://broker.emqx.io'); 
mqttClient.on('connect', () => {
  mqttClient.subscribe('lagan50ki/quiz/submit');
  mqttClient.subscribe('lagan50ki/quiz/checkin');
});
mqttClient.on('message', (topic, message) => {
  if (topic === 'lagan50ki/quiz/checkin') {
    try {
      const { device_id, status } = JSON.parse(message.toString());
      const id = parseInt(device_id);
      if (!Number.isInteger(id) || id <= 0) return;

      if (status === 'leave') {
        hardwareLobby.delete(id);
        io.emit('hardware_lobby_update', { devices: getHardwareLobby() });
        console.log(`📟 STT ${id} đã rời sảnh`);
        return;
      }

      // STT trên ESP32 chính là STT trong danh sách lớp.
      // Tra tên trực tiếp từ bảng class_students rồi mới đưa lên sảnh.
      db.query("SELECT full_name FROM class_students WHERE stt = ? LIMIT 1", [id], (err, rows) => {
        const studentName = (!err && rows && rows.length > 0)
          ? rows[0].full_name
          : 'Không tìm thấy trong danh sách';

        hardwareLobby.set(id, {
          device_id: id,
          stt: id,
          student_name: studentName
        });

        io.emit('hardware_lobby_update', { devices: getHardwareLobby() });
        console.log(`📟 Vào sảnh: STT ${id} - ${studentName}`);
      });
    } catch (e) {}
    return;
  }

  if (topic === 'lagan50ki/quiz/submit') {
    try {
      const { device_id, answer } = JSON.parse(message.toString());
      if (!currentLiveQuestion) {
        mqttClient.publish(`lagan50ki/quiz/response/${device_id}`, JSON.stringify({ success: false, error: "Chưa có đề" }));
        return;
      }
      db.query("SELECT student_name FROM hardware_mappings WHERE session_id = ? AND device_id = ?", [currentLiveQuestion.session_id, device_id], (err, results) => {
        const studentName = (results && results.length > 0) ? results[0].student_name : `Thiết bị #${device_id}`;
        const isCorrect = (answer === currentLiveQuestion.correct_answer);
        
        db.query("INSERT INTO answers (session_id, question_index, player_name, source, is_correct) VALUES (?, ?, ?, ?, ?)",
          [currentLiveQuestion.session_id, currentQuestionIndex, studentName, 'HARDWARE', isCorrect],
          (err) => {
            if (!err) {
              console.log(`✅ Cứng: [${studentName}] nộp Câu ${currentQuestionIndex + 1}`);
              io.emit('admin_track_progress', { playerName: studentName, source: 'HARDWARE', questionIndex: currentQuestionIndex, answer: answer, isCorrect: isCorrect });
              mqttClient.publish(`lagan50ki/quiz/response/${device_id}`, JSON.stringify({ success: true, isCorrect: isCorrect }));
            }
          });
      });
    } catch (e) {}
  }
});

const PORT = process.env.PORT || 3000;
// Thêm '0.0.0.0' để ép máy chủ mở cửa ra quốc tế (WiFi)
server.listen(PORT, '0.0.0.0', () => console.log(`🚀 Máy chủ Khảo thí Backend đang chạy tại cổng ${PORT}`));
import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import { fileURLToPath } from "url";
import Database from "better-sqlite3";
import cors from "cors";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const db = new Database("eduegy.db");

// Initialize Database with Comprehensive Schema
db.exec(`
  -- 1. Users & Authentication
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE,
    password TEXT,
    fullName TEXT,
    email TEXT UNIQUE,
    phone TEXT,
    role TEXT, -- ADMIN, TEACHER, STUDENT, PARENT
    status TEXT, -- active, suspended
    isVerified INTEGER DEFAULT 0,
    avatar TEXT,
    theme TEXT DEFAULT 'light',
    language TEXT DEFAULT 'ar',
    joinDate TEXT,
    educationPath TEXT, -- JSON: category, stage, branch, grade
    teacherProfile TEXT -- JSON: bio, experience, specialization
  );

  -- 2. Courses & Content
  CREATE TABLE IF NOT EXISTS courses (
    id TEXT PRIMARY KEY,
    title TEXT,
    description TEXT,
    teacherId TEXT,
    subject TEXT,
    grade TEXT,
    category TEXT,
    stage TEXT,
    thumbnail TEXT,
    price REAL DEFAULT 0,
    status TEXT DEFAULT 'draft', -- draft, published, archived
    createdAt TEXT,
    FOREIGN KEY(teacherId) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS lessons (
    id TEXT PRIMARY KEY,
    courseId TEXT,
    title TEXT,
    content TEXT, -- Markdown or HTML
    videoUrl TEXT,
    duration INTEGER, -- in minutes
    orderIndex INTEGER,
    isFree INTEGER DEFAULT 0,
    createdAt TEXT,
    FOREIGN KEY(courseId) REFERENCES courses(id)
  );

  -- 3. Quizzes & Assessments
  CREATE TABLE IF NOT EXISTS quizzes (
    id TEXT PRIMARY KEY,
    lessonId TEXT,
    courseId TEXT,
    title TEXT,
    timeLimit INTEGER, -- in minutes
    passingScore INTEGER,
    createdAt TEXT,
    FOREIGN KEY(lessonId) REFERENCES lessons(id),
    FOREIGN KEY(courseId) REFERENCES courses(id)
  );

  CREATE TABLE IF NOT EXISTS questions (
    id TEXT PRIMARY KEY,
    quizId TEXT,
    questionText TEXT,
    options TEXT, -- JSON array of options
    correctOption INTEGER, -- index of correct option
    explanation TEXT,
    FOREIGN KEY(quizId) REFERENCES quizzes(id)
  );

  -- 4. Student Progress & Interaction
  CREATE TABLE IF NOT EXISTS enrollments (
    id TEXT PRIMARY KEY,
    studentId TEXT,
    courseId TEXT,
    enrolledAt TEXT,
    progress INTEGER DEFAULT 0, -- percentage
    status TEXT DEFAULT 'active', -- active, completed, cancelled
    UNIQUE(studentId, courseId),
    FOREIGN KEY(studentId) REFERENCES users(id),
    FOREIGN KEY(courseId) REFERENCES courses(id)
  );

  CREATE TABLE IF NOT EXISTS quiz_attempts (
    id TEXT PRIMARY KEY,
    studentId TEXT,
    quizId TEXT,
    score INTEGER,
    completedAt TEXT,
    FOREIGN KEY(studentId) REFERENCES users(id),
    FOREIGN KEY(quizId) REFERENCES quizzes(id)
  );

  CREATE TABLE IF NOT EXISTS reviews (
    id TEXT PRIMARY KEY,
    courseId TEXT,
    studentId TEXT,
    rating INTEGER,
    comment TEXT,
    createdAt TEXT,
    FOREIGN KEY(courseId) REFERENCES courses(id),
    FOREIGN KEY(studentId) REFERENCES users(id)
  );

  -- 5. Financials
  CREATE TABLE IF NOT EXISTS payments (
    id TEXT PRIMARY KEY,
    userId TEXT,
    courseId TEXT,
    amount REAL,
    method TEXT, -- fawry, vodafone_cash, card
    status TEXT, -- pending, completed, failed
    transactionId TEXT,
    createdAt TEXT,
    FOREIGN KEY(userId) REFERENCES users(id),
    FOREIGN KEY(courseId) REFERENCES courses(id)
  );

  -- 6. System & Communication
  CREATE TABLE IF NOT EXISTS notifications (
    id TEXT PRIMARY KEY,
    userId TEXT, -- NULL for global notifications
    targetRole TEXT, -- ALL, STUDENT, TEACHER
    title TEXT,
    message TEXT,
    isRead INTEGER DEFAULT 0,
    createdAt TEXT
  );

  -- 7. Parent-Student Linking System
  CREATE TABLE IF NOT EXISTS linking_codes (
    id TEXT PRIMARY KEY,
    studentId TEXT,
    code TEXT UNIQUE,
    expiresAt TEXT,
    used INTEGER DEFAULT 0,
    FOREIGN KEY(studentId) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS parent_student_links (
    id TEXT PRIMARY KEY,
    parentId TEXT,
    studentId TEXT,
    status TEXT DEFAULT 'pending', -- pending, approved, rejected
    createdAt TEXT,
    UNIQUE(parentId, studentId),
    FOREIGN KEY(parentId) REFERENCES users(id),
    FOREIGN KEY(studentId) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS logs (
    id TEXT PRIMARY KEY,
    userId TEXT,
    username TEXT,
    action TEXT,
    description TEXT,
    timestamp TEXT,
    ip TEXT
  );
`);

// Helper: Generate Secure Random Code
const generateLinkingCode = () => {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = 'STU-';
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
};

// Helper to add logs to DB
const addLogToDB = (action: string, description: string, userId = 'SYSTEM', username = 'System') => {
  const id = Math.random().toString(36).substr(2, 9);
  db.prepare(`
    INSERT INTO logs (id, userId, username, action, description, timestamp, ip)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, userId, username, action, description, new Date().toISOString(), '127.0.0.1');
};

// Add default admin if not exists
const adminEmail = "Mosadghazali123@gmail.com";
const existingAdmin = db.prepare("SELECT * FROM users WHERE email = ?").get(adminEmail);
if (!existingAdmin) {
  const adminId = 'admin-mosad-001';
  db.prepare(`
    INSERT INTO users (id, username, password, fullName, email, phone, role, status, isVerified, avatar, theme, language, joinDate)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    adminId,
    'mosad_ghazali',
    adminEmail, // password is same as email as per previous logic
    'مسعد غزالي (مدير النظام)',
    adminEmail,
    '01000000000',
    'ADMIN',
    'active',
    1,
    'https://api.dicebear.com/7.x/avataaars/svg?seed=mosad',
    'light',
    'ar',
    new Date().toISOString()
  );
  addLogToDB('System Init', 'Default admin account created', adminId, 'mosad_ghazali');
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(cors());
  app.use(express.json());

  // --- Parent-Student Linking Endpoints ---

  // 1. Student: Get or Generate Linking Code
  app.get("/api/student/linking-code", (req, res) => {
    const { studentId } = req.query;
    
    // Check for existing valid code
    const existing = db.prepare(`
      SELECT * FROM linking_codes 
      WHERE studentId = ? AND used = 0 AND expiresAt > ?
    `).get(studentId, new Date().toISOString());

    if (existing) {
      return res.json({ success: true, code: existing.code, expiresAt: existing.expiresAt });
    }

    // Generate new code
    const newCode = generateLinkingCode();
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const id = Math.random().toString(36).substr(2, 9);

    db.prepare(`
      INSERT INTO linking_codes (id, studentId, code, expiresAt)
      VALUES (?, ?, ?, ?)
    `).run(id, studentId, newCode, expiresAt);

    res.json({ success: true, code: newCode, expiresAt });
  });

  // 2. Parent: Submit Linking Code
  app.post("/api/parent/link-request", (req, res) => {
    const { parentId, code } = req.body;

    // Validate Code
    const codeData = db.prepare(`
      SELECT * FROM linking_codes 
      WHERE code = ? AND used = 0 AND expiresAt > ?
    `).get(code, new Date().toISOString());

    if (!codeData) {
      return res.status(400).json({ success: false, message: "الكود غير صالح أو منتهي الصلاحية" });
    }

    const studentId = codeData.studentId;

    try {
      const linkId = Math.random().toString(36).substr(2, 9);
      db.prepare(`
        INSERT INTO parent_student_links (id, parentId, studentId, status, createdAt)
        VALUES (?, ?, ?, 'pending', ?)
      `).run(linkId, parentId, studentId, new Date().toISOString());

      res.json({ success: true, message: "تم إرسال طلب الربط بنجاح" });
    } catch (error: any) {
      res.status(400).json({ success: false, message: "طلب الربط موجود بالفعل" });
    }
  });

  // 3. Student: Get Pending Requests
  app.get("/api/student/link-requests", (req, res) => {
    const { studentId } = req.query;
    const requests = db.prepare(`
      SELECT l.*, u.fullName as parentName, u.email as parentEmail 
      FROM parent_student_links l
      JOIN users u ON l.parentId = u.id
      WHERE l.studentId = ? AND l.status = 'pending'
    `).all(studentId);
    res.json(requests);
  });

  // 4. Student: Approve/Reject Request
  app.patch("/api/student/link-requests/:id", (req, res) => {
    const { id } = req.params;
    const { status } = req.body; // approved or rejected

    db.prepare("UPDATE parent_student_links SET status = ? WHERE id = ?").run(status, id);
    
    // If approved, invalidate the code used for this student to be safe
    if (status === 'approved') {
      const link = db.prepare("SELECT studentId FROM parent_student_links WHERE id = ?").get(id);
      db.prepare("UPDATE linking_codes SET used = 1 WHERE studentId = ?").run(link.studentId);
    }

    res.json({ success: true });
  });

  // 5. Parent: Get Linked Students (Secure)
  app.get("/api/parent/students", (req, res) => {
    const { parentId } = req.query;
    const students = db.prepare(`
      SELECT u.id, u.fullName, u.avatar, u.educationPath, l.status
      FROM parent_student_links l
      JOIN users u ON l.studentId = u.id
      WHERE l.parentId = ? AND l.status = 'approved'
    `).all(parentId);
    
    // Format education path for each student
    const formatted = students.map(s => ({
      ...s,
      educationPath: s.educationPath ? JSON.parse(s.educationPath) : null
    }));
    
    res.json(formatted);
  });

  // API Routes
  app.post("/api/auth/register", (req, res) => {
    const { fullName, email, phone, password, role } = req.body;
    const id = Math.random().toString(36).substr(2, 9);
    const username = email.split('@')[0] + Math.floor(Math.random() * 1000);
    
    try {
      const stmt = db.prepare(`
        INSERT INTO users (id, username, password, fullName, email, phone, role, status, isVerified, avatar, theme, language, joinDate)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      
      stmt.run(
        id,
        username,
        password, // In a real app, hash this!
        fullName,
        email,
        phone,
        role,
        'active',
        0, // Not verified yet
        `https://api.dicebear.com/7.x/avataaars/svg?seed=${username}`,
        'light',
        'ar',
        new Date().toISOString()
      );

      addLogToDB('User Registration', `New ${role} registered: ${fullName}`, id, username);
      res.json({ success: true, user: { id, fullName, email, phone, role } });
    } catch (error: any) {
      res.status(400).json({ success: false, message: error.message });
    }
  });

  const formatUser = (user: any) => {
    if (!user) return null;
    return {
      ...user,
      isVerified: !!user.isVerified,
      educationPath: user.educationPath ? JSON.parse(user.educationPath) : null,
      teacherProfile: user.teacherProfile ? JSON.parse(user.teacherProfile) : null
    };
  };

  app.patch("/api/users/:id/teacher-profile", (req, res) => {
    const { id } = req.params;
    const { teacherProfile } = req.body;
    try {
      db.prepare("UPDATE users SET teacherProfile = ? WHERE id = ?").run(JSON.stringify(teacherProfile), id);
      res.json({ success: true });
    } catch (error: any) {
      res.status(400).json({ success: false, message: error.message });
    }
  });

  app.post("/api/auth/verify-otp", (req, res) => {
    const { email, otp } = req.body;
    // Mock OTP verification - in real app, check against stored OTP
    if (otp === '123456') {
      const stmt = db.prepare("UPDATE users SET isVerified = 1 WHERE email = ?");
      stmt.run(email);
      
      const user = db.prepare("SELECT * FROM users WHERE email = ?").get(email);
      res.json({ success: true, user: formatUser(user) });
    } else {
      res.status(400).json({ success: false, message: "Invalid OTP" });
    }
  });

  app.post("/api/auth/login", (req, res) => {
    const { identifier, password } = req.body;
    const user = db.prepare("SELECT * FROM users WHERE (email = ? OR username = ?) AND password = ?")
      .get(identifier, identifier, password);

    if (user) {
      const formatted = formatUser(user);
      if (formatted) {
        addLogToDB('User Login', `User logged in: ${formatted.fullName}`, formatted.id, formatted.username);
      }
      res.json({ success: true, user: formatted });
    } else {
      res.status(401).json({ success: false, message: "Invalid credentials" });
    }
  });

  app.get("/api/users", (req, res) => {
    const users = db.prepare("SELECT * FROM users").all();
    res.json(users.map(formatUser));
  });

  app.patch("/api/users/:id/status", (req, res) => {
    const { id } = req.params;
    const { status } = req.body;
    try {
      db.prepare("UPDATE users SET status = ? WHERE id = ?").run(status, id);
      addLogToDB('Status Update', `User ${id} status changed to ${status}`);
      res.json({ success: true });
    } catch (error: any) {
      res.status(400).json({ success: false, message: error.message });
    }
  });

  app.delete("/api/users/:id", (req, res) => {
    const { id } = req.params;
    try {
      db.prepare("DELETE FROM users WHERE id = ?").run(id);
      addLogToDB('User Deletion', `User ${id} deleted from system`);
      res.json({ success: true });
    } catch (error: any) {
      res.status(400).json({ success: false, message: error.message });
    }
  });

  // Courses API
  app.get("/api/courses", (req, res) => {
    const courses = db.prepare("SELECT * FROM courses").all();
    res.json(courses);
  });

  app.post("/api/courses", (req, res) => {
    const { title, teacherId, subject, grade, category, stage, price, thumbnail } = req.body;
    const id = Math.random().toString(36).substr(2, 9);
    try {
      db.prepare(`
        INSERT INTO courses (id, title, teacherId, subject, grade, category, stage, thumbnail, price, createdAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, title, teacherId, subject, grade, category, stage, thumbnail, price, new Date().toISOString());
      res.json({ success: true, id });
    } catch (error: any) {
      res.status(400).json({ success: false, message: error.message });
    }
  });

  // Logs API
  app.get("/api/logs", (req, res) => {
    const logs = db.prepare("SELECT * FROM logs ORDER BY timestamp DESC LIMIT 100").all();
    res.json(logs);
  });

  // Notifications API
  app.get("/api/notifications", (req, res) => {
    const { role } = req.query;
    const notes = db.prepare("SELECT * FROM notifications WHERE targetRole = 'ALL' OR targetRole = ? ORDER BY createdAt DESC")
      .all(role || 'NONE');
    res.json(notes);
  });

  app.post("/api/notifications", (req, res) => {
    const { targetRole, title, message } = req.body;
    const id = Math.random().toString(36).substr(2, 9);
    try {
      db.prepare(`
        INSERT INTO notifications (id, targetRole, title, message, createdAt)
        VALUES (?, ?, ?, ?, ?)
      `).run(id, targetRole, title, message, new Date().toISOString());
      res.json({ success: true });
    } catch (error: any) {
      res.status(400).json({ success: false, message: error.message });
    }
  });

  app.patch("/api/users/:id/education-path", (req, res) => {
    const { id } = req.params;
    const { educationPath } = req.body;
    try {
      db.prepare("UPDATE users SET educationPath = ? WHERE id = ?").run(JSON.stringify(educationPath), id);
      res.json({ success: true });
    } catch (error: any) {
      res.status(400).json({ success: false, message: error.message });
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.join(__dirname, "dist")));
    app.get("*", (req, res) => {
      res.sendFile(path.join(__dirname, "dist", "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();

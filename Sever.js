require("dotenv").config();

const express    = require("express");
const cors       = require("cors");
const mysql      = require("mysql2/promise");
const bcrypt     = require("bcrypt");
const jwt        = require("jsonwebtoken");
const crypto     = require("crypto");
const nodemailer = require("nodemailer");
const multer     = require("multer");
const fs         = require("fs");
const Razorpay   = require("razorpay");
const cloudinary = require("cloudinary").v2;
const { CloudinaryStorage } = require("multer-storage-cloudinary");

const { logBillToExcel, EXCEL_PATH } = require("./excel");

const app = express();

app.use(cors());
app.use(express.json());

// ─── Cloudinary config ────────────────────────────────────────────────────────
// Add to your .env:
//   CLOUDINARY_CLOUD_NAME=xxxx
//   CLOUDINARY_API_KEY=xxxx
//   CLOUDINARY_API_SECRET=xxxx
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// ─── Multer storage → Cloudinary (replaces local disk storage) ───────────────
const storage = new CloudinaryStorage({
  cloudinary,
  params: {
    folder: "smartpos",
    allowed_formats: ["jpg", "jpeg", "png", "webp"],
  },
});
const upload = multer({ storage });

// ─── Razorpay instance ────────────────────────────────────────────────────────
const razorpay = new Razorpay({
  key_id:     process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// ─── Plan prices (paise) ───────────────────────────────────────────────────────
const PLAN_PRICES = {
  basic:    { monthly: 19900,  yearly: 199900  },
  pro:      { monthly: 49900,  yearly: 499900  },
  business: { monthly: 99900,  yearly: 999900  },
};

// ─── Database Connection ──────────────────────────────────────────────────────
const db = mysql.createPool({
  host:     process.env.DB_HOST     || "localhost",
  user:     process.env.DB_USER     || "root",
  password: process.env.DB_PASSWORD || "",
  database: process.env.DB_NAME     || "pointofsale",
  port:     process.env.DB_PORT     || 3306,
  waitForConnections: true,
  connectionLimit: 5,
  queueLimit: 0,
});

// ─── In-memory OTP store ──────────────────────────────────────────────────────
const otpStore = {};

// ─── Nodemailer ───────────────────────────────────────────────────────────────
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

// ─── Helper: Generate Cashier ID ─────────────────────────────────────────────
async function generateCashierId() {
  const [rows] = await db.query(
    "SELECT cashier_id FROM cashiers ORDER BY id DESC LIMIT 1"
  );
  if (!rows.length) return "CASHIER001";
  const last = rows[0].cashier_id;
  const num  = parseInt(last.replace("CASHIER", ""), 10);
  return `CASHIER${String(num + 1).padStart(3, "0")}`;
}

// ─── Helper: Generate next CAT ID ────────────────────────────────────────────
const generateCatId = async () => {
  const [rows] = await db.query(
    "SELECT cat_id FROM categories WHERE cat_id IS NOT NULL ORDER BY id DESC LIMIT 1"
  );
  if (rows.length === 0) return "CAT001";
  const lastNum = parseInt(rows[0].cat_id.replace("CAT", ""), 10);
  return "CAT" + String(lastNum + 1).padStart(3, "0");
};

// ─── Helper: Generate next PROD ID ───────────────────────────────────────────
const generateProdId = async () => {
  const [rows] = await db.query(
    "SELECT product_id FROM products WHERE product_id IS NOT NULL ORDER BY id DESC LIMIT 1"
  );
  if (rows.length === 0) return "PROD001";
  const lastNum = parseInt(rows[0].product_id.replace("PROD", ""), 10);
  return "PROD" + String(lastNum + 1).padStart(3, "0");
};

// ─── Middleware: Verify JWT Token ─────────────────────────────────────────────
const verifyToken = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer "))
    return res.status(401).json({ success: false, message: "Unauthorized" });

  const token = authHeader.split(" ")[1];
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || "smartpossecret");
    req.vendor = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ success: false, message: "Invalid or expired token" });
  }
};

// ═════════════════════════════════════════════════════════════════════════════
// AUTH ROUTES
// ═════════════════════════════════════════════════════════════════════════════

app.post("/api/vendors/send-otp", async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ success: false, message: "Email required" });

    const otp = crypto.randomInt(100000, 999999).toString();
    otpStore[email] = { otp, expires: Date.now() + 5 * 60 * 1000 };

    console.log(`\n🔑 OTP for ${email} : ${otp}\n`);

    transporter.sendMail({
      from:    process.env.EMAIL_USER,
      to:      email,
      subject: "Your SmartPOS Verification Code",
      html: `
        <div style="font-family:sans-serif;max-width:480px;margin:auto;padding:24px;border:1px solid #E2E8F0;border-radius:12px;">
          <h2 style="color:#2563EB;margin-bottom:8px;">SmartPOS Verification</h2>
          <p style="color:#374151;">Use the code below to verify your email address:</p>
          <div style="font-size:36px;font-weight:800;letter-spacing:8px;color:#111;text-align:center;padding:20px 0;">${otp}</div>
          <p style="color:#94A3B8;font-size:13px;">This code expires in 5 minutes. Do not share it with anyone.</p>
        </div>
      `,
    }).catch(err => console.error("Mail failed (non-blocking):", err.message));

    res.json({ success: true, message: "OTP sent successfully" });
  } catch (error) {
    console.error("send-otp error:", error);
    res.status(500).json({ success: false, message: "Failed to send OTP" });
  }
});

app.post("/api/vendors/verify-otp", (req, res) => {
  const { email, otp } = req.body;
  if (!email || !otp)
    return res.status(400).json({ success: false, message: "Email and OTP are required" });

  const record = otpStore[email];
  if (!record)
    return res.status(400).json({ success: false, message: "OTP not found. Please request a new one." });
  if (Date.now() > record.expires) {
    delete otpStore[email];
    return res.status(400).json({ success: false, message: "OTP has expired. Please request a new one." });
  }
  if (record.otp !== otp)
    return res.status(400).json({ success: false, message: "Incorrect OTP. Please try again." });

  delete otpStore[email];
  res.json({ success: true, message: "OTP verified successfully" });
});

app.post("/api/vendors/register", async (req, res) => {
  try {
    const { storeName, businessType, ownerName, mobile, email, gst, address, pincode, password } = req.body;

    const [existingByMobile] = await db.query("SELECT id FROM vendors WHERE mobile = ?", [mobile]);
    if (existingByMobile.length > 0)
      return res.status(400).json({ success: false, message: "Mobile number already registered" });

    const [existingByEmail] = await db.query("SELECT id FROM vendors WHERE email = ?", [email]);
    if (existingByEmail.length > 0)
      return res.status(400).json({ success: false, message: "Email address already registered" });

    const [rows] = await db.query("SELECT vendor_id FROM vendors ORDER BY id DESC LIMIT 1");
    let vendorId = "VENDOR001";
    if (rows.length > 0) {
      const lastNumber = parseInt(rows[0].vendor_id.replace("VENDOR", ""));
      vendorId = "VENDOR" + String(lastNumber + 1).padStart(3, "0");
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    await db.query(
      `INSERT INTO vendors
        (vendor_id, store_name, business_type, owner_name, mobile, email, gst, address, pincode, password)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [vendorId, storeName, businessType, ownerName, mobile, email, gst || null, address, pincode, hashedPassword]
    );

    res.status(201).json({ success: true, vendorId, message: "Vendor registered successfully" });
  } catch (error) {
    console.error("register error:", error);
    res.status(500).json({ success: false, message: "Server error during registration" });
  }
});

app.post("/api/vendors/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password)
      return res.status(400).json({ success: false, message: "Email and password are required" });

    const [rows] = await db.query("SELECT * FROM vendors WHERE email = ?", [email]);
    if (rows.length === 0)
      return res.status(400).json({ success: false, message: "Invalid email or password" });

    const vendor  = rows[0];
    const isMatch = await bcrypt.compare(password, vendor.password);
    if (!isMatch)
      return res.status(400).json({ success: false, message: "Invalid email or password" });

    const token = jwt.sign(
      { id: vendor.id, vendorId: vendor.vendor_id },
      process.env.JWT_SECRET || "smartpossecret",
      { expiresIn: "7d" }
    );

    res.json({
      success: true,
      token,
      vendor: {
        id:        vendor.id,
        vendorId:  vendor.vendor_id,
        storeName: vendor.store_name,
        ownerName: vendor.owner_name,
        mobile:    vendor.mobile,
        email:     vendor.email,
      },
    });
  } catch (error) {
    console.error("login error:", error);
    res.status(500).json({ success: false, message: "Server error during login" });
  }
});

app.get("/api/vendors/profile", verifyToken, async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT vendor_id, store_name, business_type, owner_name,
              mobile, email, gst, address, pincode, created_at, subscription_plan
       FROM vendors WHERE id = ?`,
      [req.vendor.id]
    );
    if (rows.length === 0)
      return res.status(404).json({ success: false, message: "Vendor not found" });

    const v = rows[0];
    const memberSince = new Date(v.created_at).toLocaleDateString("en-IN", {
      month: "short", year: "numeric",
    });

    const [salesRows] = await db.query(
      `SELECT COALESCE(SUM(total), 0) AS total_sales, COUNT(*) AS total_orders FROM bills`
    );
    const [todayRows] = await db.query(
      `SELECT COALESCE(SUM(total), 0) AS today_sales FROM bills WHERE DATE(created_at) = CURDATE()`
    );

    res.json({
      success: true,
      vendor: {
        storeName:        v.store_name,
        businessType:     v.business_type,
        ownerName:        v.owner_name,
        mobile:           v.mobile,
        email:            v.email,
        gst:              v.gst || "",
        address:          v.address,
        pincode:          v.pincode,
        memberSince,
        subscriptionPlan: v.subscription_plan || "free",
        totalSales:       "₹" + Number(salesRows[0].total_sales).toLocaleString("en-IN"),
        totalOrders:      Number(salesRows[0].total_orders).toLocaleString("en-IN"),
        todaySales:       "₹" + Number(todayRows[0].today_sales).toLocaleString("en-IN"),
      },
    });
  } catch (error) {
    console.error("GET /api/vendors/profile error:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

app.put("/api/vendors/profile", verifyToken, async (req, res) => {
  try {
    const { storeName, businessType, ownerName, mobile, gst, address, pincode } = req.body;

    if (!storeName || !businessType || !ownerName || !mobile || !address || !pincode)
      return res.status(400).json({ success: false, message: "Required fields are missing" });

    if (!/^[6-9]\d{9}$/.test(mobile))
      return res.status(400).json({ success: false, message: "Invalid mobile number" });

    if (!/^\d{6}$/.test(pincode))
      return res.status(400).json({ success: false, message: "Invalid pincode" });

    const [mobileCheck] = await db.query(
      "SELECT id FROM vendors WHERE mobile = ? AND id != ?",
      [mobile, req.vendor.id]
    );
    if (mobileCheck.length > 0)
      return res.status(400).json({ success: false, message: "Mobile number already in use" });

    await db.query(
      `UPDATE vendors
       SET store_name=?, business_type=?, owner_name=?, mobile=?, gst=?, address=?, pincode=?
       WHERE id=?`,
      [storeName, businessType, ownerName, mobile, gst || null, address, pincode, req.vendor.id]
    );

    res.json({ success: true, message: "Profile updated successfully" });
  } catch (error) {
    console.error("PUT /api/vendors/profile error:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

app.put("/api/vendors/change-password", verifyToken, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword)
      return res.status(400).json({ success: false, message: "Both passwords are required" });

    if (newPassword.length < 8)
      return res.status(400).json({ success: false, message: "Password must be at least 8 characters" });

    if (!/[0-9]/.test(newPassword))
      return res.status(400).json({ success: false, message: "Password must include at least one number" });

    const [rows] = await db.query("SELECT password FROM vendors WHERE id = ?", [req.vendor.id]);
    if (rows.length === 0)
      return res.status(404).json({ success: false, message: "Vendor not found" });

    const isMatch = await bcrypt.compare(currentPassword, rows[0].password);
    if (!isMatch)
      return res.status(400).json({ success: false, message: "Current password is incorrect" });

    const hashed = await bcrypt.hash(newPassword, 10);
    await db.query("UPDATE vendors SET password = ? WHERE id = ?", [hashed, req.vendor.id]);

    res.json({ success: true, message: "Password changed successfully" });
  } catch (error) {
    console.error("PUT /api/vendors/change-password error:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// RAZORPAY ROUTES
// ═════════════════════════════════════════════════════════════════════════════

app.post("/api/payment/create-order", verifyToken, async (req, res) => {
  try {
    const { planKey, billingCycle } = req.body;

    if (!PLAN_PRICES[planKey])
      return res.status(400).json({ success: false, message: "Invalid plan" });

    if (!["monthly", "yearly"].includes(billingCycle))
      return res.status(400).json({ success: false, message: "Invalid billing cycle" });

    const amount   = PLAN_PRICES[planKey][billingCycle];
    const currency = "INR";
    const receipt  = `rcpt_${req.vendor.id}_${Date.now()}`;

    const order = await razorpay.orders.create({
      amount,
      currency,
      receipt,
      notes: {
        vendor_id:     req.vendor.id,
        plan_key:      planKey,
        billing_cycle: billingCycle,
      },
    });

    res.json({
      success:  true,
      order_id: order.id,
      amount:   order.amount,
      currency: order.currency,
      key_id:   process.env.RAZORPAY_KEY_ID,
    });
  } catch (error) {
    console.error("POST /api/payment/create-order error:", error);
    res.status(500).json({ success: false, message: "Failed to create payment order" });
  }
});

app.post("/api/payment/verify", verifyToken, async (req, res) => {
  try {
    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
      planKey,
      billingCycle,
    } = req.body;

    const body     = razorpay_order_id + "|" + razorpay_payment_id;
    const expected = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(body)
      .digest("hex");

    if (expected !== razorpay_signature) {
      return res.status(400).json({
        success: false,
        message: "Payment verification failed. Signature mismatch.",
      });
    }

    const days    = billingCycle === "yearly" ? 365 : 30;
    const expires = new Date(Date.now() + days * 24 * 60 * 60 * 1000);

    await db.query(
      `UPDATE vendors SET subscription_plan = ?, plan_expires_at = ? WHERE id = ?`,
      [planKey, expires, req.vendor.id]
    );

    await db.query(
      `INSERT INTO payments
         (vendor_id, razorpay_order_id, razorpay_payment_id, plan_key, billing_cycle, amount, status)
       VALUES (?, ?, ?, ?, ?, ?, 'success')`,
      [
        req.vendor.id,
        razorpay_order_id,
        razorpay_payment_id,
        planKey,
        billingCycle,
        PLAN_PRICES[planKey][billingCycle] / 100,
      ]
    );

    const [vendorRows] = await db.query(
      "SELECT email, owner_name, store_name FROM vendors WHERE id = ?",
      [req.vendor.id]
    );
    if (vendorRows.length) {
      const v = vendorRows[0];
      transporter.sendMail({
        from:    process.env.EMAIL_USER,
        to:      v.email,
        subject: `SmartPOS — ${planKey.charAt(0).toUpperCase() + planKey.slice(1)} Plan Activated 🎉`,
        html: `
          <div style="font-family:sans-serif;max-width:520px;margin:auto;padding:24px;border:1px solid #E2E8F0;border-radius:12px;">
            <h2 style="color:#2563EB;">Your plan has been upgraded!</h2>
            <p>Hello <strong>${v.owner_name}</strong>,</p>
            <p>Thank you for upgrading <strong>${v.store_name}</strong> to the
               <strong>${planKey.toUpperCase()}</strong> plan.</p>
            <table style="width:100%;border-collapse:collapse;margin-top:16px;">
              <tr><td style="padding:8px;border:1px solid #E2E8F0;color:#64748B;">Plan</td><td style="padding:8px;border:1px solid #E2E8F0;font-weight:700;">${planKey.toUpperCase()}</td></tr>
              <tr><td style="padding:8px;border:1px solid #E2E8F0;color:#64748B;">Billing</td><td style="padding:8px;border:1px solid #E2E8F0;">${billingCycle}</td></tr>
              <tr><td style="padding:8px;border:1px solid #E2E8F0;color:#64748B;">Expires</td><td style="padding:8px;border:1px solid #E2E8F0;">${expires.toLocaleDateString("en-IN")}</td></tr>
              <tr><td style="padding:8px;border:1px solid #E2E8F0;color:#64748B;">Payment ID</td><td style="padding:8px;border:1px solid #E2E8F0;font-family:monospace;">${razorpay_payment_id}</td></tr>
            </table>
            <p style="margin-top:20px;color:#94A3B8;font-size:13px;">
              If you have any questions, reply to this email or contact SmartPOS support.
            </p>
          </div>
        `,
      }).catch(e => console.error("upgrade email failed:", e));
    }

    res.json({
      success: true,
      message: `Upgraded to ${planKey} plan successfully`,
      plan:    planKey,
      expires: expires.toISOString(),
    });
  } catch (error) {
    console.error("POST /api/payment/verify error:", error);
    res.status(500).json({ success: false, message: "Payment verification failed" });
  }
});

app.get("/api/payment/status", verifyToken, async (req, res) => {
  try {
    const [[vendor]] = await db.query(
      "SELECT subscription_plan, plan_expires_at FROM vendors WHERE id = ?",
      [req.vendor.id]
    );

    const plan       = vendor?.subscription_plan || "free";
    const expiresAt  = vendor?.plan_expires_at;
    const isExpired  = expiresAt ? new Date(expiresAt) < new Date() : false;
    const activePlan = isExpired ? "free" : plan;

    if (isExpired && plan !== "free") {
      await db.query(
        "UPDATE vendors SET subscription_plan = 'free' WHERE id = ?",
        [req.vendor.id]
      );
    }

    res.json({
      success:    true,
      plan:       activePlan,
      expires_at: expiresAt,
      is_expired: isExpired,
    });
  } catch (error) {
    console.error("GET /api/payment/status error:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// CATEGORIES  (image upload now via Cloudinary)
// ═════════════════════════════════════════════════════════════════════════════

app.get("/categories", async (req, res) => {
  try {
    const [rows] = await db.query("SELECT * FROM categories ORDER BY id DESC");
    res.json(rows);
  } catch (err) {
    console.error("GET /categories error:", err);
    res.status(500).json({ message: "Failed to fetch categories" });
  }
});

app.post("/categories", upload.single("image"), async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ message: "Category name is required" });

    const cat_id = await generateCatId();
    // ✅ req.file.path is already the full Cloudinary URL — no manual URL building needed
    const image  = req.file ? req.file.path : null;

    const [result] = await db.query(
      "INSERT INTO categories (cat_id, name, image) VALUES (?, ?, ?)",
      [cat_id, name, image]
    );

    res.status(201).json({ id: result.insertId, cat_id, name, image });
  } catch (err) {
    console.error("POST /categories error:", err);
    res.status(500).json({ message: "Failed to add category" });
  }
});

app.put("/categories/:id", upload.single("image"), async (req, res) => {
  try {
    const { id }   = req.params;
    const { name } = req.body;

    const [existing] = await db.query("SELECT * FROM categories WHERE id = ?", [id]);
    if (existing.length === 0)
      return res.status(404).json({ message: "Category not found" });

    const image       = req.file ? req.file.path : existing[0].image;
    const updatedName = name ?? existing[0].name;

    await db.query(
      "UPDATE categories SET name = ?, image = ? WHERE id = ?",
      [updatedName, image, id]
    );

    res.json({ id: Number(id), cat_id: existing[0].cat_id, name: updatedName, image });
  } catch (err) {
    console.error("PUT /categories/:id error:", err);
    res.status(500).json({ message: "Failed to update category" });
  }
});

app.delete("/categories/:id", async (req, res) => {
  try {
    const [result] = await db.query("DELETE FROM categories WHERE id = ?", [req.params.id]);
    if (result.affectedRows === 0)
      return res.status(404).json({ message: "Category not found" });
    res.json({ message: "Deleted successfully" });
  } catch (err) {
    console.error("DELETE /categories/:id error:", err);
    res.status(500).json({ message: "Failed to delete category" });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// PRODUCTS  (image upload now via Cloudinary)
// ═════════════════════════════════════════════════════════════════════════════

app.get("/products", async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT p.*, c.name AS category_name, c.cat_id
      FROM products p
      LEFT JOIN categories c ON p.category_id = c.id
      ORDER BY p.id DESC
    `);
    res.json(rows);
  } catch (err) {
    console.error("GET /products error:", err);
    res.status(500).json({ message: "Failed to fetch products" });
  }
});

app.post("/products", upload.single("image"), async (req, res) => {
  try {
    const { name, price, stock, category_id } = req.body;
    if (!name)        return res.status(400).json({ message: "Product name is required" });
    if (!price)       return res.status(400).json({ message: "Price is required" });
    if (!category_id) return res.status(400).json({ message: "Category is required" });

    const product_id = await generateProdId();
    const image       = req.file ? req.file.path : null;

    const [result] = await db.query(
      "INSERT INTO products (product_id, name, price, stock, category_id, image) VALUES (?, ?, ?, ?, ?, ?)",
      [product_id, name, price, stock ?? 0, category_id, image]
    );

    const [rows] = await db.query(`
      SELECT p.*, c.name AS category_name, c.cat_id
      FROM products p
      LEFT JOIN categories c ON p.category_id = c.id
      WHERE p.id = ?
    `, [result.insertId]);

    res.status(201).json(rows[0]);
  } catch (err) {
    console.error("POST /products error:", err);
    res.status(500).json({ message: "Failed to add product" });
  }
});

app.put("/products/:id", upload.single("image"), async (req, res) => {
  try {
    const { id }                          = req.params;
    const { name, price, stock, category_id } = req.body;

    const [existing] = await db.query("SELECT * FROM products WHERE id = ?", [id]);
    if (existing.length === 0)
      return res.status(404).json({ message: "Product not found" });

    const image = req.file ? req.file.path : existing[0].image;

    await db.query(
      "UPDATE products SET name = ?, price = ?, stock = ?, category_id = ?, image = ? WHERE id = ?",
      [
        name        ?? existing[0].name,
        price       ?? existing[0].price,
        stock       ?? existing[0].stock,
        category_id ?? existing[0].category_id,
        image, id,
      ]
    );

    const [rows] = await db.query(`
      SELECT p.*, c.name AS category_name, c.cat_id
      FROM products p
      LEFT JOIN categories c ON p.category_id = c.id
      WHERE p.id = ?
    `, [id]);

    res.json(rows[0]);
  } catch (err) {
    console.error("PUT /products/:id error:", err);
    res.status(500).json({ message: "Failed to update product" });
  }
});

app.delete("/products/:id", async (req, res) => {
  try {
    const [result] = await db.query("DELETE FROM products WHERE id = ?", [req.params.id]);
    if (result.affectedRows === 0)
      return res.status(404).json({ message: "Product not found" });
    res.json({ message: "Deleted successfully" });
  } catch (err) {
    console.error("DELETE /products/:id error:", err);
    res.status(500).json({ message: "Failed to delete product" });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// INVENTORY
// ═════════════════════════════════════════════════════════════════════════════

app.get("/inventory", async (req, res) => {
  try {
    const [rows] = await db.query("SELECT * FROM inventory ORDER BY id DESC");
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error("GET /inventory error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/inventory/:id", async (req, res) => {
  try {
    const [rows] = await db.query("SELECT * FROM inventory WHERE id = ?", [req.params.id]);
    if (rows.length === 0)
      return res.status(404).json({ success: false, error: "Item not found" });
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/inventory", async (req, res) => {
  try {
    const { item_name, stock, min_stock, unit } = req.body;
    if (!item_name || stock === undefined || stock === "" || !unit)
      return res.status(400).json({ success: false, error: "item_name, stock, unit are required" });

    const minStockVal = min_stock ?? 10;
    const [result]    = await db.query(
      "INSERT INTO inventory (item_name, stock, min_stock, unit) VALUES (?, ?, ?, ?)",
      [item_name, Number(stock), Number(minStockVal), unit]
    );

    db.query(
      "INSERT INTO stock_history (inventory_id, quantity, type) VALUES (?, ?, 'IN')",
      [result.insertId, Number(stock)]
    ).catch(() => {});

    res.status(201).json({ success: true, message: "Item created", id: result.insertId });
  } catch (err) {
    console.error("POST /inventory error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.put("/inventory/:id", async (req, res) => {
  try {
    const { quantity, type } = req.body;
    if (!quantity || !["IN", "OUT"].includes(type))
      return res.status(400).json({ success: false, error: "quantity and type (IN/OUT) required" });

    const [rows] = await db.query("SELECT stock FROM inventory WHERE id = ?", [req.params.id]);
    if (rows.length === 0)
      return res.status(404).json({ success: false, error: "Item not found" });

    const current  = Number(rows[0].stock);
    const qty      = Number(quantity);
    const newStock = type === "IN" ? current + qty : Math.max(0, current - qty);

    await db.query("UPDATE inventory SET stock = ? WHERE id = ?", [newStock, req.params.id]);

    db.query(
      "INSERT INTO stock_history (inventory_id, quantity, type) VALUES (?, ?, ?)",
      [req.params.id, qty, type]
    ).catch(() => {});

    res.json({ success: true, new_stock: newStock });
  } catch (err) {
    console.error("PUT /inventory/:id error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete("/inventory/:id", async (req, res) => {
  try {
    await db.query("DELETE FROM stock_history WHERE inventory_id = ?", [req.params.id]);
    const [result] = await db.query("DELETE FROM inventory WHERE id = ?", [req.params.id]);
    if (result.affectedRows === 0)
      return res.status(404).json({ success: false, error: "Item not found" });
    res.json({ success: true, message: "Item deleted" });
  } catch (err) {
    console.error("DELETE /inventory/:id error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/inventory/:id/history", async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT sh.*, i.item_name, i.unit
       FROM stock_history sh
       JOIN inventory i ON i.id = sh.inventory_id
       WHERE sh.inventory_id = ?
       ORDER BY sh.created_at DESC`,
      [req.params.id]
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// CASHIERS
// ═════════════════════════════════════════════════════════════════════════════

app.get("/cashiers", async (req, res) => {
  try {
    const [rows] = await db.query(
      "SELECT id, cashier_id, name, phone, email, created_at FROM cashiers ORDER BY id DESC"
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to fetch cashiers" });
  }
});

app.post("/cashiers", verifyToken, async (req, res) => {
  const { name, phone, email, password } = req.body;

  if (!name || !phone || !email || !password)
    return res.status(400).json({ message: "All fields are required" });

  try {
    const [existing] = await db.query("SELECT id FROM cashiers WHERE email = ?", [email]);
    if (existing.length)
      return res.status(409).json({ message: "Email already registered" });

    const vendor_id     = req.vendor.id;
    const cashier_id    = await generateCashierId();
    const password_hash = await bcrypt.hash(password, 10);

    const [result] = await db.query(
      "INSERT INTO cashiers (cashier_id, vendor_id, name, phone, email, password_hash) VALUES (?, ?, ?, ?, ?, ?)",
      [cashier_id, vendor_id, name, phone, email, password_hash]
    );

    transporter.sendMail({
      from:    process.env.EMAIL_USER,
      to:      email,
      subject: "SmartPOS Cashier Account Created",
      html: `
        <div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;">
          <h2 style="color:#2563EB;">Welcome to SmartPOS</h2>
          <p>Hello <strong>${name}</strong>,</p>
          <p>Your cashier account has been created successfully.</p>
          <table style="border-collapse:collapse;width:100%;">
            <tr><td style="padding:8px;border:1px solid #ddd;"><strong>Cashier ID</strong></td><td style="padding:8px;border:1px solid #ddd;">${cashier_id}</td></tr>
            <tr><td style="padding:8px;border:1px solid #ddd;"><strong>Email</strong></td><td style="padding:8px;border:1px solid #ddd;">${email}</td></tr>
            <tr><td style="padding:8px;border:1px solid #ddd;"><strong>Password</strong></td><td style="padding:8px;border:1px solid #ddd;">${password}</td></tr>
          </table>
          <p style="margin-top:20px;">Please log in and change your password after first login.</p>
          <p>Regards,<br><strong>SmartPOS Team</strong></p>
        </div>
      `,
    }).catch(err => console.error('Cashier email failed:', err));

    res.status(201).json({
      success: true,
      message: "Cashier created successfully and email sent",
      cashier: { id: result.insertId, cashier_id, name, phone, email },
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Failed to create cashier" });
  }
});

app.put("/cashiers/:id", async (req, res) => {
  const { id }                       = req.params;
  const { name, phone, email, password } = req.body;

  try {
    const [rows] = await db.query("SELECT * FROM cashiers WHERE id = ?", [id]);
    if (!rows.length)
      return res.status(404).json({ message: "Cashier not found" });

    const updates = [];
    const values  = [];

    if (name)     { updates.push("name = ?");          values.push(name); }
    if (phone)    { updates.push("phone = ?");         values.push(phone); }
    if (email)    { updates.push("email = ?");         values.push(email); }
    if (password) {
      const hash = await bcrypt.hash(password, 10);
      updates.push("password_hash = ?");
      values.push(hash);
    }

    if (!updates.length)
      return res.status(400).json({ message: "Nothing to update" });

    values.push(id);
    await db.query(`UPDATE cashiers SET ${updates.join(", ")} WHERE id = ?`, values);

    const [updated] = await db.query(
      "SELECT id, cashier_id, name, phone, email FROM cashiers WHERE id = ?",
      [id]
    );
    res.json(updated[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to update cashier" });
  }
});

app.delete("/cashiers/:id", async (req, res) => {
  const { id } = req.params;
  try {
    const [rows] = await db.query("SELECT id FROM cashiers WHERE id = ?", [id]);
    if (!rows.length)
      return res.status(404).json({ message: "Cashier not found" });

    await db.query("DELETE FROM cashiers WHERE id = ?", [id]);
    res.json({ message: "Cashier deleted successfully" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to delete cashier" });
  }
});

app.post("/cashiers/login", async (req, res) => {
  const { cashier_id, password } = req.body;
  if (!cashier_id || !password)
    return res.status(400).json({ message: "Cashier ID and password are required" });

  try {
    const [rows] = await db.query(
      "SELECT * FROM cashiers WHERE cashier_id = ?",
      [cashier_id.toUpperCase()]
    );
    if (!rows.length)
      return res.status(401).json({ message: "Invalid Cashier ID or password" });

    const cashier = rows[0];
    const match   = await bcrypt.compare(password, cashier.password_hash);
    if (!match)
      return res.status(401).json({ message: "Invalid Cashier ID or password" });

    res.json({
      id:         cashier.id,
      cashier_id: cashier.cashier_id,
      name:       cashier.name,
      phone:      cashier.phone,
      email:      cashier.email,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Login failed" });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// BILLS
// ═════════════════════════════════════════════════════════════════════════════

app.post("/bills", async (req, res) => {
  const connection = await db.getConnection();

  try {
    const { cashier_id, subtotal, gst, total, payment_method, cash_given, change_amount, items } = req.body;

    const [[cashierRow]] = await connection.query(
      "SELECT vendor_id FROM cashiers WHERE cashier_id = ?",
      [cashier_id]
    );
    if (!cashierRow) {
      connection.release();
      return res.status(400).json({ success: false, message: "Invalid cashier_id" });
    }
    const vendorId = cashierRow.vendor_id;

    const [[vendorRow]] = await connection.query(
      "SELECT subscription_plan, plan_expires_at FROM vendors WHERE id = ?",
      [vendorId]
    );

    let planKey = vendorRow?.subscription_plan || "free";

    if (planKey !== "free" && vendorRow?.plan_expires_at) {
      if (new Date(vendorRow.plan_expires_at) < new Date()) {
        planKey = "free";
        await connection.query(
          "UPDATE vendors SET subscription_plan = 'free' WHERE id = ?",
          [vendorId]
        );
      }
    }

    if (planKey === "free") {
      const [[{ count }]] = await connection.query(
        `SELECT COUNT(*) AS count
         FROM bills b
         JOIN cashiers c ON c.cashier_id = b.cashier_id
         WHERE c.vendor_id = ?`,
        [vendorId]
      );

      if (count >= 10) {
        connection.release();
        return res.status(403).json({
          success: false,
          code:    "BILL_LIMIT_REACHED",
          message: "Free plan allows 10 bills total. Upgrade to continue billing.",
        });
      }
    }

    await connection.beginTransaction();

    const billNo = `BILL${Date.now()}`;

    const [billResult] = await connection.query(
      `INSERT INTO bills
         (bill_no, cashier_id, subtotal, gst, total, payment_method, cash_given, change_amount)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [billNo, cashier_id, subtotal, gst, total, payment_method, cash_given || 0, change_amount || 0]
    );

    const billId = billResult.insertId;

    for (const item of items) {
      await connection.query(
        `INSERT INTO bill_items
           (bill_id, product_id, product_name, price, quantity, total)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [billId, item.id, item.name, item.price, item.qty, item.price * item.qty]
      );
      await connection.query(
        "UPDATE products SET stock = stock - ? WHERE id = ?",
        [item.qty, item.id]
      );
    }

    await connection.commit();

    let cashierName = "";
    try {
      const [cashierRows] = await db.query(
        "SELECT name FROM cashiers WHERE cashier_id = ?",
        [cashier_id]
      );
      if (cashierRows.length) cashierName = cashierRows[0].name;
    } catch (e) {
      console.error("cashier lookup for excel log failed:", e);
    }

    logBillToExcel({
      billNo, cashier_id, cashierName,
      subtotal, gst, total,
      payment_method, cash_given, change_amount, items,
    }).catch(err => console.error("Excel log failed for", billNo, err));

    res.status(201).json({
      success: true,
      bill_id: billId,
      bill_no: billNo,
      message: "Bill saved successfully",
    });

  } catch (err) {
    try { await connection.rollback(); } catch (_) {}
    console.error("POST /bills error:", err);
    res.status(500).json({ success: false, message: "Failed to save bill" });
  } finally {
    connection.release();
  }
});

app.get("/bills/export", (req, res) => {
  if (!fs.existsSync(EXCEL_PATH))
    return res.status(404).json({ message: "No sales log yet" });
  res.download(EXCEL_PATH, "sales_log.xlsx");
});

app.get("/bills", async (req, res) => {
  try {
    const { cashier_id } = req.query;
    let query = `
      SELECT
        b.*,
        c.name AS cashier_name,
        GROUP_CONCAT(bi.product_name ORDER BY bi.id SEPARATOR ', ') AS item_summary
      FROM bills b
      LEFT JOIN cashiers c  ON c.cashier_id = b.cashier_id
      LEFT JOIN bill_items bi ON bi.bill_id = b.id
    `;
    const params = [];
    if (cashier_id) {
      query += " WHERE b.cashier_id = ?";
      params.push(cashier_id);
    }
    query += " GROUP BY b.id ORDER BY b.created_at DESC";

    const [rows] = await db.query(query, params);

    const billIds = rows.map(r => r.id);
    let itemsMap  = {};
    if (billIds.length) {
      const [itemRows] = await db.query(
        `SELECT bill_id, product_name AS name, price, quantity AS qty
         FROM bill_items WHERE bill_id IN (?)`,
        [billIds]
      );
      itemRows.forEach(it => {
        if (!itemsMap[it.bill_id]) itemsMap[it.bill_id] = [];
        itemsMap[it.bill_id].push(it);
      });
    }

    const result = rows.map(b => ({ ...b, items: itemsMap[b.id] || [] }));
    res.json(result);
  } catch (err) {
    console.error("GET /bills error:", err);
    res.status(500).json({ message: "Failed to fetch bills" });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// HEALTH CHECK & START
// ═════════════════════════════════════════════════════════════════════════════

app.get("/", (req, res) => res.send("SmartPOS Backend Running ✅"));

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
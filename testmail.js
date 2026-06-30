const nodemailer = require("nodemailer");

const transporter = nodemailer.createTransport({
  host: "smtp.gmail.com",
  port: 465,
  secure: true,
  auth: {
    user: "karneya.r2002@gmail.com",
    pass: "fyuuhtjbdqqzquvr",
  },
});

transporter.verify((error, success) => {
  if (error) {
    console.log("❌ Error:", error);
  } else {
    console.log("✅ Server ready to send emails");
  }
});
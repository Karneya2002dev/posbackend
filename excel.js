// ─── excel-logger.js ────────────────────────────────────────────────────────
// Helper module: appends every completed bill to a shared sales_log.xlsx file
// on the server, and lets you fetch/download the current sheet.
//
// Install dependency first:
//   npm install exceljs
//
// Usage in server.js:
//   const { logBillToExcel, EXCEL_PATH } = require('./excel-logger');
//   ... inside POST /bills, after connection.commit():
//   await logBillToExcel({ billNo, cashier_id, cashierName, subtotal, gst, total,
//                           payment_method, cash_given, change_amount, items });

const ExcelJS = require('exceljs');
const path = require('path');
const fs = require('fs');

// Stored alongside server.js — change this path if you want it elsewhere
// (e.g. a mounted network drive, or /uploads so it's downloadable as a static file).
const EXCEL_PATH = path.join(__dirname, 'sales_log.xlsx');

const HEADERS = [
  { header: 'Bill No',        key: 'bill_no',        width: 22 },
  { header: 'Date',           key: 'date',            width: 14 },
  { header: 'Time',           key: 'time',            width: 12 },
  { header: 'Cashier ID',     key: 'cashier_id',      width: 14 },
  { header: 'Cashier Name',   key: 'cashier_name',    width: 18 },
  { header: 'Item Name',      key: 'item_name',       width: 26 },
  { header: 'Qty',            key: 'qty',             width: 8  },
  { header: 'Unit Price',     key: 'unit_price',      width: 12 },
  { header: 'Line Total',     key: 'line_total',      width: 12 },
  { header: 'Bill Subtotal',  key: 'subtotal',         width: 14 },
  { header: 'GST',            key: 'gst',              width: 10 },
  { header: 'Bill Total',     key: 'total',            width: 12 },
  { header: 'Payment Method', key: 'payment_method',   width: 14 },
  { header: 'Cash Given',     key: 'cash_given',       width: 12 },
  { header: 'Change',         key: 'change_amount',    width: 10 },
];

// A simple in-process lock so two concurrent /bills requests don't
// read-modify-write the file at the same time and clobber each other.
let writeQueue = Promise.resolve();

async function getOrCreateWorkbook() {
  const workbook = new ExcelJS.Workbook();
  if (fs.existsSync(EXCEL_PATH)) {
    await workbook.xlsx.readFile(EXCEL_PATH);
  }
  let sheet = workbook.getWorksheet('Sales Log');
  if (!sheet) {
    sheet = workbook.addWorksheet('Sales Log');
    sheet.columns = HEADERS;
    sheet.getRow(1).font = { bold: true };
    sheet.getRow(1).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFDBEAFE' },
    };
  }
  return { workbook, sheet };
}

/**
 * Appends one row per item in the bill (so the sheet stays fully itemized
 * and easy to pivot/filter in Excel). Bill-level fields repeat on every
 * row belonging to that bill.
 */
async function logBillToExcel(bill) {
  // Chain onto the queue so writes never overlap.
  writeQueue = writeQueue.then(() => _doLog(bill)).catch(err => {
    console.error('excel-logger write failed:', err);
    // swallow so one bad write doesn't permanently break the queue
  });
  return writeQueue;
}

async function _doLog(bill) {
  const {
    bill_no, cashier_id, cashierName,
    subtotal, gst, total,
    payment_method, cash_given, change_amount,
    items,
  } = bill;

  const { workbook, sheet } = await getOrCreateWorkbook();

  const now = new Date();
  const date = now.toLocaleDateString('en-IN');
  const time = now.toLocaleTimeString('en-IN');

  const rowsToAdd = items.map(item => ({
    bill_no,
    date,
    time,
    cashier_id: cashier_id || '',
    cashier_name: cashierName || '',
    item_name: item.name,
    qty: item.qty,
    unit_price: Number(item.price),
    line_total: Number(item.price) * item.qty,
    subtotal: Number(subtotal),
    gst: Number(gst || 0),
    total: Number(total),
    payment_method,
    cash_given: Number(cash_given || 0),
    change_amount: Number(change_amount || 0),
  }));

  rowsToAdd.forEach(row => sheet.addRow(row));

  await workbook.xlsx.writeFile(EXCEL_PATH);
}

module.exports = { logBillToExcel, EXCEL_PATH };
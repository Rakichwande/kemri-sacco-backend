function isValidKenyanPhone(phone) {
  const cleaned = String(phone).replace(/\D/g, '');
  return /^(254(7|1)\d{8}|0(7|1)\d{8})$/.test(cleaned);
}

function isValidIdNumber(id) {
  const cleaned = String(id).trim();
  return /^\d{6,10}$/.test(cleaned);
}

function validateMemberRegistration(req, res, next) {
  const { full_name, id_number, phone_number, age } = req.body;
  const errors = [];

  if (!full_name || full_name.trim().length < 2) {
    errors.push('full_name must be at least 2 characters');
  }
  if (!id_number || !isValidIdNumber(id_number)) {
    errors.push('id_number must be 6-10 digits');
  }
  if (!phone_number || !isValidKenyanPhone(phone_number)) {
    errors.push('phone_number must be a valid Kenyan number (e.g. 0712345678 or 254712345678)');
  }
  if (age !== undefined && (isNaN(age) || age < 18 || age > 120)) {
    errors.push('age must be a number between 18 and 120');
  }

  if (errors.length > 0) {
    return res.status(400).json({ errors });
  }

  next();
}

function validatePaymentInitiation(req, res, next) {
  const { memberId, phoneNumber, amount } = req.body;
  const errors = [];

  if (!memberId || isNaN(memberId)) {
    errors.push('memberId must be a valid number');
  }
  if (!phoneNumber || !isValidKenyanPhone(phoneNumber)) {
    errors.push('phoneNumber must be a valid Kenyan number');
  }
  if (!amount || isNaN(amount) || amount <= 0) {
    errors.push('amount must be a positive number');
  }
  if (amount && amount > 150000) {
    errors.push('amount exceeds Daraja single-transaction limit (KES 150,000)');
  }

  if (errors.length > 0) {
    return res.status(400).json({ errors });
  }

  next();
}

module.exports = { validateMemberRegistration, validatePaymentInitiation, isValidKenyanPhone };
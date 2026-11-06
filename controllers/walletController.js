const WalletTransaction = require('../models/WalletTransaction');

exports.getWithdrawals = async (req, res) => {
  try {
    const withdrawals = await WalletTransaction.getWithdrawals();
    res.json(withdrawals);
  } catch (err) {
    console.error('Fetch withdrawals error:', err);
    res.status(500).json({ error: 'Server error' });
  }
};
const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// Enable CORS for all origins
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());

// In-Memory Database
const db = {
  users: {},
  pendingDeposits: [],
  giftCodes: {},
  wingo: {
    '30s': { duration: 30, timeLeft: 30, period: null, history: [], forcedNext: null },
    '1m':  { duration: 60, timeLeft: 60, period: null, history: [], forcedNext: null },
    '3m':  { duration: 180, timeLeft: 180, period: null, history: [], forcedNext: null },
    '5m':  { duration: 300, timeLeft: 300, period: null, history: [], forcedNext: null }
  }
};

const generatePeriod = (mode) => {
  const dateStr = new Date().toISOString().replace(/[-T:\.Z]/g, '').slice(0, 12);
  return `${dateStr}-${mode}`;
};

const calculateFirstDepositBonus = (amount) => {
  if (amount >= 5000) return 2001;
  if (amount >= 2000) return 520;
  if (amount >= 800) return 988;
  if (amount >= 500) return 230;
  if (amount >= 300) return 188;
  if (amount >= 100) return 55;
  return 0;
};

const resolveOutcomeAttributes = (num) => {
  const size = num >= 5 ? 'Big' : 'Small';
  let colors = [];
  if (num === 0) colors = ['Red', 'Violet'];
  else if (num === 5) colors = ['Green', 'Violet'];
  else if ([1, 3, 7, 9].includes(num)) colors = ['Green'];
  else colors = ['Red'];
  return { number: num, size, colors };
};

// Initialize Periods
Object.keys(db.wingo).forEach(mode => {
  db.wingo[mode].period = generatePeriod(mode);
});

// Real-Time Background Game Engine
setInterval(() => {
  Object.keys(db.wingo).forEach(mode => {
    const game = db.wingo[mode];
    game.timeLeft -= 1;

    if (game.timeLeft <= 0) {
      let selectedNum = game.forcedNext !== null ? game.forcedNext : Math.floor(Math.random() * 10);
      game.forcedNext = null;

      const result = {
        period: game.period,
        ...resolveOutcomeAttributes(selectedNum),
        timestamp: new Date().toISOString()
      };

      game.history.unshift(result);
      if (game.history.length > 20) game.history.pop();

      game.timeLeft = game.duration;
      game.period = generatePeriod(mode);
    }
  });
}, 1000);

// API Endpoints
app.get('/api/ping', (req, res) => {
  res.json({ status: true, message: 'Server Active' });
});

app.post('/api/auth/register', (req, res) => {
  const { phone, password, inviteCode } = req.body;
  if (!phone || !password) return res.status(400).json({ error: 'Phone and password required' });
  if (!inviteCode || String(inviteCode).trim() === '') {
    return res.status(400).json({ error: 'Invite code is mandatory' });
  }
  if (db.users[phone]) return res.status(400).json({ error: 'User already exists' });

  db.users[phone] = {
    phone,
    password,
    balance: 0,
    inviteCode,
    deposits: [],
    lastRealDeposit: 0,
    lossBonusClaimed: false
  };

  res.json({ success: true, message: 'Registration successful', user: { phone, balance: 0 } });
});

app.get('/api/user/:phone', (req, res) => {
  const user = db.users[req.params.phone];
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ phone: user.phone, balance: user.balance });
});

app.get('/api/wingo/state/:mode', (req, res) => {
  const game = db.wingo[req.params.mode];
  if (!game) return res.status(400).json({ error: 'Invalid mode' });

  res.json({
    mode: req.params.mode,
    timeLeft: game.timeLeft,
    period: game.period,
    history: game.history
  });
});

app.post('/api/wallet/deposit', (req, res) => {
  const { phone, amount, txnId } = req.body;
  const numAmount = Number(amount);
  if (!db.users[phone]) return res.status(404).json({ error: 'User not found' });
  if (!numAmount || numAmount <= 0 || !txnId) return res.status(400).json({ error: 'Invalid deposit payload' });

  const record = {
    id: 'DEP_' + Date.now(),
    phone,
    amount: numAmount,
    txnId,
    status: 'pending',
    createdAt: new Date().toISOString()
  };

  db.pendingDeposits.push(record);
  res.json({ success: true, message: 'Deposit request submitted', depositId: record.id });
});

app.post('/api/wallet/claim-loss-bonus', (req, res) => {
  const { phone } = req.body;
  const user = db.users[phone];
  if (!user) return res.status(404).json({ error: 'User not found' });

  if (user.balance > 0) return res.status(400).json({ error: 'Balance must be 0 to claim loss bonus' });
  if (user.lastRealDeposit <= 0) return res.status(400).json({ error: 'No deposit history found' });
  if (user.lossBonusClaimed) return res.status(400).json({ error: 'Loss bonus already claimed' });

  const bonusAmount = user.lastRealDeposit * 0.50;
  user.balance += bonusAmount;
  user.lossBonusClaimed = true;

  res.json({ success: true, message: `50% Loss Bonus claimed: ₹${bonusAmount}`, balance: user.balance });
});

app.get('/api/admin/pending-deposits', (req, res) => {
  res.json({ pending: db.pendingDeposits.filter(d => d.status === 'pending') });
});

app.post('/api/admin/action-deposit', (req, res) => {
  const { reqId, action } = req.body;
  const deposit = db.pendingDeposits.find(d => d.id === reqId);

  if (!deposit || deposit.status !== 'pending') {
    return res.status(400).json({ error: 'Pending deposit request not found' });
  }

  deposit.status = action;
  if (action === 'accept') {
    const user = db.users[deposit.phone];
    if (user) {
      let bonus = user.deposits.length === 0 ? calculateFirstDepositBonus(deposit.amount) : 0;
      user.balance += (deposit.amount + bonus);
      user.lastRealDeposit = deposit.amount;
      user.lossBonusClaimed = false;
      user.deposits.push(deposit);
    }
  }

  res.json({ success: true, message: `Deposit ${action}ed successfully` });
});

app.post('/api/admin/set-result', (req, res) => {
  const { mode, number } = req.body;
  const game = db.wingo[mode];
  const num = Number(number);

  if (!game) return res.status(400).json({ error: 'Invalid mode' });
  if (isNaN(num) || num < 0 || num > 9) return res.status(400).json({ error: 'Number must be between 0 and 9' });

  game.forcedNext = num;
  res.json({ success: true, message: `Next winning outcome for ${mode} forced to ${num}` });
});

app.post('/api/admin/create-giftcode', (req, res) => {
  const { code, amount } = req.body;
  if (!code || !amount || Number(amount) <= 0) return res.status(400).json({ error: 'Invalid code or amount' });

  db.giftCodes[code] = { amount: Number(amount), claimedBy: [] };
  res.json({ success: true, message: 'Gift code created successfully', code, amount: Number(amount) });
});

// JSON Catch-All Route (Prevents Unexpected Token '<' Error)
app.use((req, res) => {
  res.status(404).json({ error: `API Endpoint ${req.originalUrl} not found on server.` });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
            

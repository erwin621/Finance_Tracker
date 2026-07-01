require('dotenv').config();
const express = require('express');
const path    = require('path');
const cors    = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));   // raised limit for JSON imports
app.use(express.static(path.join(__dirname, 'public')));

// persistSession: false prevents signInWithPassword() from storing the user session
// on this server-side client. Without this, supabase-js replaces the service-role
// authorization header with the user's JWT on subsequent requests, which makes
// every data query subject to RLS — causing "violates row-level security policy" errors.
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
    auth: {
        persistSession:     false,
        autoRefreshToken:   false,
        detectSessionInUrl: false
    }
});

// ─── DATABASE MIGRATION ────────────────────────────────────────────────────────
//
//  Run these ONCE in your Supabase SQL Editor before deploying this version:
//
//  -- 1. Add user_id to existing tables
//  ALTER TABLE accounts     ADD COLUMN IF NOT EXISTS user_id UUID;
//  ALTER TABLE transactions ADD COLUMN IF NOT EXISTS user_id UUID;
//  ALTER TABLE liabilities  ADD COLUMN IF NOT EXISTS user_id UUID;
//
//  -- 2. Add category support to transactions
//  ALTER TABLE transactions ADD COLUMN IF NOT EXISTS category_id UUID;
//
//  -- 3. Create the categories table
//  CREATE TABLE IF NOT EXISTS categories (
//    id         UUID         DEFAULT gen_random_uuid() PRIMARY KEY,
//    name       TEXT         NOT NULL,
//    type       TEXT         NOT NULL DEFAULT 'both',  -- 'income' | 'expense' | 'both'
//    user_id    UUID,
//    created_at TIMESTAMPTZ  DEFAULT now()
//  );
//
//  -- 4. Create the transfers table
//  CREATE TABLE IF NOT EXISTS transfers (
//    id              UUID          DEFAULT gen_random_uuid() PRIMARY KEY,
//    from_account_id UUID          NOT NULL,
//    to_account_id   UUID          NOT NULL,
//    amount          DECIMAL(12,2) NOT NULL CHECK (amount > 0),
//    description     TEXT,
//    user_id         UUID,
//    created_at      TIMESTAMPTZ   DEFAULT now()
//  );
//
//  -- 5. Create user_settings table (daily goal + future prefs)
//  CREATE TABLE IF NOT EXISTS user_settings (
//    id         UUID          DEFAULT gen_random_uuid() PRIMARY KEY,
//    user_id    UUID          NOT NULL UNIQUE,
//    daily_goal DECIMAL(12,2) NOT NULL DEFAULT 0,
//    updated_at TIMESTAMPTZ   DEFAULT now()
//  );
//
//  -- 4. Optional FK references (recommended)
//  ALTER TABLE accounts     ADD CONSTRAINT fk_acc_user  FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
//  ALTER TABLE transactions ADD CONSTRAINT fk_tx_user   FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
//  ALTER TABLE liabilities  ADD CONSTRAINT fk_liab_user FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
//  ALTER TABLE categories   ADD CONSTRAINT fk_cat_user  FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
//
//  NOTE: Enable Email Confirmations in Supabase:
//  Dashboard → Authentication → Providers → Email → "Confirm email" ON
//
// ──────────────────────────────────────────────────────────────────────────────

// ─── CASH FLOW & FINANCIAL PLANNING MODULE — MIGRATION (additive, run once) ───
//
//  Everything below is additive: new optional columns and new tables.
//  Nothing here removes or renames an existing column/table, so every
//  existing endpoint keeps working exactly as it did before.
//
//  -- 1. Track "sites completed" on Primary Job income entries, and let an
//        expense transaction optionally link back to the liability it pays.
//  ALTER TABLE transactions ADD COLUMN IF NOT EXISTS sites_completed INTEGER;
//  ALTER TABLE transactions ADD COLUMN IF NOT EXISTS liability_id    UUID;
//
//  -- 2. Debt Manager fields on the existing liabilities table.
//  ALTER TABLE liabilities ADD COLUMN IF NOT EXISTS original_amount DECIMAL(12,2);
//  ALTER TABLE liabilities ADD COLUMN IF NOT EXISTS monthly_payment DECIMAL(12,2);
//  ALTER TABLE liabilities ADD COLUMN IF NOT EXISTS due_day         INTEGER;  -- 1-31, for recurring monthly due dates
//
//  -- 3. Cash-flow planning preferences on the existing user_settings table.
//  ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS daily_family_budget DECIMAL(12,2) DEFAULT 700;
//  ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS daily_fuel_budget   DECIMAL(12,2) DEFAULT 250;
//  ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS payroll_days        INTEGER[]     DEFAULT ARRAY[15,30];
//  ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS expected_payroll    DECIMAL(12,2) DEFAULT 6750;
//  ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS currency            TEXT          DEFAULT 'PHP';
//  ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS notification_prefs  JSONB         DEFAULT
//    '{"payroll_tomorrow":true,"fuel_low":true,"buffer_goal":true,"debt_due":true,"cash_low":true,"financial_risk":true}'::jsonb;
//
//  -- 4. Goals — powers BOTH the Operating Buffer and the Goal Planner.
//        (type = 'buffer' for the operating-buffer milestones, 'savings' for everything else)
//  CREATE TABLE IF NOT EXISTS goals (
//    id             UUID          DEFAULT gen_random_uuid() PRIMARY KEY,
//    user_id        UUID          NOT NULL,
//    name           TEXT          NOT NULL,
//    type           TEXT          NOT NULL DEFAULT 'savings',  -- 'buffer' | 'savings'
//    target_amount  DECIMAL(12,2) NOT NULL,
//    current_amount DECIMAL(12,2) NOT NULL DEFAULT 0,
//    target_date    DATE,
//    created_at     TIMESTAMPTZ   DEFAULT now()
//  );
//
//  -- 5. Goal contribution ledger — powers the Calendar view and automatic
//        "estimated completion date" projections (no manual math required).
//  CREATE TABLE IF NOT EXISTS goal_contributions (
//    id         UUID          DEFAULT gen_random_uuid() PRIMARY KEY,
//    goal_id    UUID          NOT NULL,
//    user_id    UUID          NOT NULL,
//    amount     DECIMAL(12,2) NOT NULL,
//    created_at TIMESTAMPTZ   DEFAULT now()
//  );
//
//  -- 6. Fuel Tracker log.
//  CREATE TABLE IF NOT EXISTS fuel_logs (
//    id             UUID          DEFAULT gen_random_uuid() PRIMARY KEY,
//    user_id        UUID          NOT NULL,
//    log_date       DATE          NOT NULL DEFAULT CURRENT_DATE,
//    liters         DECIMAL(8,2),
//    cost           DECIMAL(10,2) NOT NULL CHECK (cost > 0),
//    odometer       DECIMAL(10,1),
//    station        TEXT,
//    notes          TEXT,
//    transaction_id UUID,                    -- links to the auto-created "Fuel" expense transaction
//    created_at     TIMESTAMPTZ   DEFAULT now()
//  );
//  -- If you already ran the previous migration, add the column:
//  ALTER TABLE fuel_logs ADD COLUMN IF NOT EXISTS transaction_id UUID;
//
//  -- 7. Optional FK references (recommended).
//  ALTER TABLE goals              ADD CONSTRAINT fk_goal_user FOREIGN KEY (user_id)     REFERENCES auth.users(id) ON DELETE CASCADE;
//  ALTER TABLE goal_contributions ADD CONSTRAINT fk_gc_user   FOREIGN KEY (user_id)     REFERENCES auth.users(id) ON DELETE CASCADE;
//  ALTER TABLE goal_contributions ADD CONSTRAINT fk_gc_goal   FOREIGN KEY (goal_id)     REFERENCES goals(id)      ON DELETE CASCADE;
//  ALTER TABLE fuel_logs          ADD CONSTRAINT fk_fuel_user FOREIGN KEY (user_id)     REFERENCES auth.users(id) ON DELETE CASCADE;
//  ALTER TABLE transactions       ADD CONSTRAINT fk_tx_liab   FOREIGN KEY (liability_id) REFERENCES liabilities(id) ON DELETE SET NULL;
//
// ──────────────────────────────────────────────────────────────────────────────

// ── Auth Middleware ───────────────────────────────────────────────────────────
async function requireAuth(req, res, next) {
    const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
    if (!token) return res.status(401).json({ error: 'Not authenticated' });

    try {
        const { data: { user }, error } = await supabase.auth.getUser(token);
        if (error || !user) {
            return res.status(401).json({ error: 'Session expired. Please sign in again.' });
        }
        if (!user.email_confirmed_at) {
            return res.status(403).json({
                error: 'Email not verified. Please check your inbox.',
                code:  'EMAIL_NOT_VERIFIED'
            });
        }
        req.user  = user;
        req.token = token;
        next();
    } catch (e) {
        res.status(401).json({ error: 'Authentication failed' });
    }
}

// ── AUTH ROUTES ───────────────────────────────────────────────────────────────

// POST /api/auth/signup
app.post('/api/auth/signup', async (req, res) => {
    try {
        const { email, password, name } = req.body;
        if (!email || !password)  return res.status(400).json({ error: 'Email and password are required' });
        if (password.length < 6)  return res.status(400).json({ error: 'Password must be at least 6 characters' });

        const { data, error } = await supabase.auth.signUp({
            email,
            password,
            options: { data: { full_name: name || email.split('@')[0] } }
        });

        if (error) return res.status(400).json({ error: error.message });

        res.json({
            email:   data.user?.email,
            message: 'Account created! Check your email to verify your account before signing in.'
        });
    } catch (e) {
        console.error('Signup error:', e);
        res.status(500).json({ error: 'Sign up failed. Please try again.' });
    }
});

// POST /api/auth/signin
app.post('/api/auth/signin', async (req, res) => {
    try {
        const { email, password } = req.body;
        if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });

        const { data, error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) return res.status(401).json({ error: error.message });

        if (!data.user.email_confirmed_at) {
            return res.status(403).json({
                error: 'Please verify your email before signing in.',
                code:  'EMAIL_NOT_VERIFIED',
                email: data.user.email
            });
        }

        res.json({
            token:     data.session.access_token,
            expiresAt: data.session.expires_at,
            user: {
                id:    data.user.id,
                email: data.user.email,
                name:  data.user.user_metadata?.full_name || data.user.email.split('@')[0]
            }
        });
    } catch (e) {
        console.error('Signin error:', e);
        res.status(500).json({ error: 'Sign in failed. Please try again.' });
    }
});

// POST /api/auth/signout
app.post('/api/auth/signout', async (req, res) => {
    const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
    if (token) {
        try { await supabase.auth.admin.signOut(token); } catch (_) { /* ignore */ }
    }
    res.json({ success: true });
});

// GET /api/auth/me — verify token on page load
app.get('/api/auth/me', async (req, res) => {
    const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
    if (!token) return res.json({ user: null });
    try {
        const { data: { user }, error } = await supabase.auth.getUser(token);
        if (error || !user || !user.email_confirmed_at) return res.json({ user: null });
        res.json({
            user: {
                id:    user.id,
                email: user.email,
                name:  user.user_metadata?.full_name || user.email.split('@')[0]
            }
        });
    } catch (e) {
        res.json({ user: null });
    }
});

// ── DASHBOARD ─────────────────────────────────────────────────────────────────
app.get('/api/dashboard', requireAuth, async (req, res) => {
    try {
        const uid = req.user.id;
        const { start, end } = req.query;

        const { data: accounts, error: accError } = await supabase
            .from('accounts').select('*').eq('user_id', uid);
        if (accError) throw accError;

        let txQuery = supabase.from('transactions').select('type, amount').eq('user_id', uid);
        let recentQuery = supabase.from('transactions')
            .select('id, type, amount, description, created_at, account_id, accounts(name)')
            .eq('user_id', uid)
            .order('created_at', { ascending: false })
            .limit(5);

        if (start && end) {
            txQuery     = txQuery.gte('created_at', start).lte('created_at', end);
            recentQuery = recentQuery.gte('created_at', start).lte('created_at', end);
        }

        const { data: allTx,  error: txError }     = await txQuery;
        const { data: recent, error: recentError } = await recentQuery;
        if (txError)     throw txError;
        if (recentError) throw recentError;

        let totalBalance = 0;
        (accounts || []).forEach(a => { totalBalance += parseFloat(a.balance) || 0; });

        let income = 0, expense = 0;
        (allTx || []).forEach(tx => {
            if (tx.type === 'income') income  += parseFloat(tx.amount) || 0;
            else                      expense += parseFloat(tx.amount) || 0;
        });

        const savingsRate = income > 0 ? Math.round(((income - expense) / income) * 100) : 0;

        // Fetch recent transfers for the same timeframe
        let trQuery = supabase.from('transfers')
            .select('id, amount, description, created_at, from_account_id, to_account_id')
            .eq('user_id', uid)
            .order('created_at', { ascending: false })
            .limit(5);
        if (start && end) trQuery = trQuery.gte('created_at', start).lte('created_at', end);
        const { data: recentTransfers } = await trQuery;

        res.json({
            summary: { totalBalance, income, expense, savingsRate },
            accounts: accounts || [],
            recentTransactions: recent || [],
            recentTransfers:    recentTransfers || []
        });
    } catch (e) {
        console.error('Dashboard Error:', e);
        res.status(500).json({ error: e.message || 'Failed to load dashboard' });
    }
});

// ── TRANSACTIONS ──────────────────────────────────────────────────────────────
app.get('/api/transactions', requireAuth, async (req, res) => {
    try {
        const uid = req.user.id;
        const { start, end } = req.query;
        let query = supabase.from('transactions')
            .select('*, accounts(name)')
            .eq('user_id', uid)
            .order('created_at', { ascending: false });

        if (start && end) query = query.gte('created_at', start).lte('created_at', end);
        const { data, error } = await query;
        if (error) throw error;
        res.json(data || []);
    } catch (e) {
        res.status(500).json({ error: e.message || 'Failed to load transactions' });
    }
});

app.post('/api/transactions', requireAuth, async (req, res) => {
    try {
        const uid = req.user.id;
        const { account_id, type, amount, description, category_id, sites_completed, liability_id } = req.body;

        if (!account_id || !type || !amount) return res.status(400).json({ error: 'Missing required fields: account_id, type, amount' });
        if (!['income', 'expense'].includes(type)) return res.status(400).json({ error: 'type must be "income" or "expense"' });
        if (isNaN(parseFloat(amount)) || parseFloat(amount) <= 0) return res.status(400).json({ error: 'amount must be a positive number' });

        const payload = { account_id, type, amount: parseFloat(amount), description, user_id: uid };
        if (category_id) payload.category_id = category_id;
        // Cash Flow module additions — both optional. sites_completed powers Income Tracking's
        // Primary Job quick-log; liability_id links a Debt Manager payment back to its debt.
        if (sites_completed !== undefined && sites_completed !== '' && sites_completed !== null) payload.sites_completed = parseInt(sites_completed);
        if (liability_id) payload.liability_id = liability_id;

        const { data, error } = await supabase.from('transactions').insert([payload]).select();
        if (error) throw error;
        res.status(201).json(data[0]);
    } catch (e) {
        res.status(500).json({ error: e.message || 'Failed to create transaction' });
    }
});

app.put('/api/transactions/:id', requireAuth, async (req, res) => {
    try {
        const uid = req.user.id;
        const { id } = req.params;
        const { account_id, type, amount, description, category_id, sites_completed, liability_id } = req.body;

        if (!account_id || !type || !amount) return res.status(400).json({ error: 'Missing required fields' });
        if (!['income', 'expense'].includes(type)) return res.status(400).json({ error: 'Invalid type' });
        if (isNaN(parseFloat(amount)) || parseFloat(amount) <= 0) return res.status(400).json({ error: 'Invalid amount' });

        const updates = { account_id, type, amount: parseFloat(amount), description };
        if (category_id !== undefined) updates.category_id = category_id || null;
        if (sites_completed !== undefined) updates.sites_completed = (sites_completed === '' || sites_completed === null) ? null : parseInt(sites_completed);
        if (liability_id !== undefined) updates.liability_id = liability_id || null;

        const { data, error } = await supabase.from('transactions')
            .update(updates).eq('id', id).eq('user_id', uid).select();
        if (error) throw error;
        if (!data || data.length === 0) return res.status(404).json({ error: 'Transaction not found' });
        res.json(data[0]);
    } catch (e) {
        res.status(500).json({ error: e.message || 'Failed to update transaction' });
    }
});

// ── ACCOUNTS CRUD ─────────────────────────────────────────────────────────────
app.delete('/api/transactions/:id', requireAuth, async (req, res) => {
    try {
        const uid = req.user.id, { id } = req.params;
        const { error } = await supabase.from('transactions').delete().eq('id', id).eq('user_id', uid);
        if (error) throw error;
        res.status(204).send();
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/accounts', requireAuth, async (req, res) => {
    try {
        const { data, error } = await supabase.from('accounts').select('*')
            .eq('user_id', req.user.id).order('created_at', { ascending: true });
        if (error) throw error;
        res.json(data || []);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/accounts', requireAuth, async (req, res) => {
    try {
        const { name, balance } = req.body;
        if (!name?.trim()) return res.status(400).json({ error: 'name is required' });
        const { data, error } = await supabase.from('accounts')
            .insert([{ name: name.trim(), balance: parseFloat(balance) || 0, user_id: req.user.id }]).select();
        if (error) throw error;
        res.status(201).json(data[0]);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/accounts/:id', requireAuth, async (req, res) => {
    try {
        const { name, balance } = req.body;
        if (!name?.trim()) return res.status(400).json({ error: 'name is required' });
        const { data, error } = await supabase.from('accounts')
            .update({ name: name.trim(), balance: parseFloat(balance) || 0 })
            .eq('id', req.params.id).eq('user_id', req.user.id).select();
        if (error) throw error;
        if (!data?.length) return res.status(404).json({ error: 'Account not found' });
        res.json(data[0]);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/accounts/:id', requireAuth, async (req, res) => {
    try {
        const { error } = await supabase.from('accounts')
            .delete().eq('id', req.params.id).eq('user_id', req.user.id);
        if (error) throw error;
        res.status(204).send();
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── TRANSFERS ─────────────────────────────────────────────────────────────────
app.get('/api/transfers', requireAuth, async (req, res) => {
    try {
        const uid = req.user.id;
        const { start, end } = req.query;
        let query = supabase.from('transfers').select('*')
            .eq('user_id', uid)
            .order('created_at', { ascending: false });
        if (start && end) query = query.gte('created_at', start).lte('created_at', end);
        const { data, error } = await query;
        if (error) throw error;
        res.json(data || []);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/transfers', requireAuth, async (req, res) => {
    try {
        const uid = req.user.id;
        const { from_account_id, to_account_id, amount, description } = req.body;

        if (!from_account_id || !to_account_id || !amount)
            return res.status(400).json({ error: 'from_account_id, to_account_id, and amount are required' });
        if (from_account_id === to_account_id)
            return res.status(400).json({ error: 'Cannot transfer to the same account' });
        if (isNaN(parseFloat(amount)) || parseFloat(amount) <= 0)
            return res.status(400).json({ error: 'amount must be a positive number' });

        const amt = parseFloat(amount);

        // Verify both accounts belong to this user and get current balances
        const { data: accounts, error: accErr } = await supabase
            .from('accounts').select('id, balance')
            .in('id', [from_account_id, to_account_id])
            .eq('user_id', uid);
        if (accErr) throw accErr;
        if (!accounts || accounts.length !== 2)
            return res.status(404).json({ error: 'One or both accounts not found' });

        const fromAcc = accounts.find(function(a){ return a.id === from_account_id; });
        const toAcc   = accounts.find(function(a){ return a.id === to_account_id;   });

        // Record the transfer
        const { data: transfer, error: trErr } = await supabase.from('transfers')
            .insert([{ from_account_id, to_account_id, amount: amt, description, user_id: uid }])
            .select();
        if (trErr) throw trErr;

        // Update account balances
        await Promise.all([
            supabase.from('accounts').update({ balance: parseFloat(fromAcc.balance) - amt }).eq('id', from_account_id).eq('user_id', uid),
            supabase.from('accounts').update({ balance: parseFloat(toAcc.balance)   + amt }).eq('id', to_account_id).eq('user_id', uid)
        ]);

        res.status(201).json(transfer[0]);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── CATEGORIES CRUD ───────────────────────────────────────────────────────────
app.get('/api/categories', requireAuth, async (req, res) => {
    try {
        const { data, error } = await supabase.from('categories').select('*')
            .eq('user_id', req.user.id).order('name', { ascending: true });
        if (error) throw error;
        res.json(data || []);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/categories', requireAuth, async (req, res) => {
    try {
        const { name, type } = req.body;
        if (!name?.trim()) return res.status(400).json({ error: 'name is required' });
        if (!['income', 'expense', 'both'].includes(type)) return res.status(400).json({ error: 'type must be income, expense, or both' });
        const { data, error } = await supabase.from('categories')
            .insert([{ name: name.trim(), type, user_id: req.user.id }]).select();
        if (error) throw error;
        res.status(201).json(data[0]);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/categories/:id', requireAuth, async (req, res) => {
    try {
        const { name, type } = req.body;
        if (!name?.trim()) return res.status(400).json({ error: 'name is required' });
        if (!['income', 'expense', 'both'].includes(type)) return res.status(400).json({ error: 'Invalid type' });
        const { data, error } = await supabase.from('categories')
            .update({ name: name.trim(), type })
            .eq('id', req.params.id).eq('user_id', req.user.id).select();
        if (error) throw error;
        if (!data?.length) return res.status(404).json({ error: 'Category not found' });
        res.json(data[0]);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/categories/:id', requireAuth, async (req, res) => {
    try {
        const { error } = await supabase.from('categories')
            .delete().eq('id', req.params.id).eq('user_id', req.user.id);
        if (error) throw error;
        res.status(204).send();
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── LIABILITIES ───────────────────────────────────────────────────────────────
//
//  Full table schema (includes both due_date and user_id):
//
//  CREATE TABLE liabilities (
//    id          UUID          DEFAULT gen_random_uuid() PRIMARY KEY,
//    name        TEXT          NOT NULL,
//    amount      DECIMAL(12,2) NOT NULL CHECK (amount > 0),
//    due_date    DATE,
//    user_id     UUID,
//    created_at  TIMESTAMPTZ   DEFAULT now()
//  );
//
// ─────────────────────────────────────────────────────────────────────────────

app.get('/api/liabilities', requireAuth, async (req, res) => {
    try {
        const uid = req.user.id;
        const { data, error } = await supabase.from('liabilities').select('*')
            .eq('user_id', uid)
            .order('due_date',   { ascending: true, nullsFirst: false })
            .order('created_at', { ascending: true });
        if (error) throw error;
        res.json(data || []);
    } catch (e) {
        res.status(500).json({ error: e.message || 'Failed to load liabilities' });
    }
});

app.post('/api/liabilities', requireAuth, async (req, res) => {
    try {
        const uid = req.user.id;
        const { name, amount, due_date, original_amount, monthly_payment, due_day } = req.body;
        if (!name?.trim()) return res.status(400).json({ error: 'name is required' });
        if (isNaN(parseFloat(amount)) || parseFloat(amount) <= 0) return res.status(400).json({ error: 'amount must be a positive number' });

        const payload = { name: name.trim(), amount: parseFloat(amount), user_id: uid };
        if (due_date) payload.due_date = due_date;
        // Debt Manager additions — all optional, backward compatible.
        payload.original_amount = (original_amount !== undefined && original_amount !== '' && original_amount !== null)
            ? parseFloat(original_amount) : parseFloat(amount);
        if (monthly_payment !== undefined && monthly_payment !== '' && monthly_payment !== null) payload.monthly_payment = parseFloat(monthly_payment);
        if (due_day !== undefined && due_day !== '' && due_day !== null) payload.due_day = parseInt(due_day);

        const { data, error } = await supabase.from('liabilities').insert([payload]).select();
        if (error) throw error;
        res.status(201).json(data[0]);
    } catch (e) {
        res.status(500).json({ error: e.message || 'Failed to add liability' });
    }
});

app.delete('/api/liabilities/:id', requireAuth, async (req, res) => {
    try {
        const uid = req.user.id;
        const { id } = req.params;
        const { error } = await supabase.from('liabilities')
            .delete().eq('id', id).eq('user_id', uid);
        if (error) throw error;
        res.status(204).send();
    } catch (e) {
        res.status(500).json({ error: e.message || 'Failed to delete liability' });
    }
});

// ── EXPORT ────────────────────────────────────────────────────────────────────
app.get('/api/export', requireAuth, async (req, res) => {
    try {
        const uid = req.user.id;
        const [
            { data: accounts },
            { data: transactions },
            { data: liabilities }
        ] = await Promise.all([
            supabase.from('accounts').select('*').eq('user_id', uid),
            supabase.from('transactions').select('*').eq('user_id', uid).order('created_at', { ascending: true }),
            supabase.from('liabilities').select('*').eq('user_id', uid)
        ]);

        res.setHeader('Content-Disposition', `attachment; filename="finance-backup-${Date.now()}.json"`);
        res.json({
            exportedAt:   new Date().toISOString(),
            version:      '1.0',
            user:         { id: uid, email: req.user.email },
            accounts:     accounts     || [],
            transactions: transactions || [],
            liabilities:  liabilities  || []
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ── IMPORT: CLAIM UNCLAIMED RECORDS (user_id IS NULL) ─────────────────────────
//  Used on first login to restore existing data to the new profile
app.post('/api/import/claim', requireAuth, async (req, res) => {
    try {
        const uid = req.user.id;
        const [
            { data: accs  },
            { data: txs   },
            { data: liabs }
        ] = await Promise.all([
            supabase.from('accounts').select('id').is('user_id', null),
            supabase.from('transactions').select('id').is('user_id', null),
            supabase.from('liabilities').select('id').is('user_id', null)
        ]);
        await Promise.all([
            supabase.from('accounts').update({ user_id: uid }).is('user_id', null),
            supabase.from('transactions').update({ user_id: uid }).is('user_id', null),
            supabase.from('liabilities').update({ user_id: uid }).is('user_id', null)
        ]);
        res.json({
            success: true,
            claimed: {
                accounts:     (accs  || []).length,
                transactions: (txs   || []).length,
                liabilities:  (liabs || []).length
            }
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ── IMPORT: RESTORE FROM JSON BACKUP ─────────────────────────────────────────
app.post('/api/import/json', requireAuth, async (req, res) => {
    try {
        const uid = req.user.id;
        const { accounts = [], transactions = [], liabilities = [] } = req.body;

        // 1. Insert accounts and build old_id → new_id map for transaction relinking
        const idMap = {};
        if (accounts.length > 0) {
            const rows = accounts.map(a => ({
                name: a.name, balance: a.balance || 0, created_at: a.created_at, user_id: uid
            }));
            const { data, error } = await supabase.from('accounts').insert(rows).select();
            if (!error && data) accounts.forEach((old, i) => { if (data[i]) idMap[old.id] = data[i].id; });
        }

        // 2. Insert transactions with remapped account_id
        let importedTx = 0;
        if (transactions.length > 0) {
            const rows = transactions.map(t => ({
                type:        t.type,
                amount:      t.amount,
                description: t.description,
                account_id:  idMap[t.account_id] || t.account_id,
                created_at:  t.created_at,
                user_id:     uid
            }));
            const { data, error } = await supabase.from('transactions').insert(rows).select();
            if (!error && data) importedTx = data.length;
        }

        // 3. Insert liabilities
        let importedLiab = 0;
        if (liabilities.length > 0) {
            const rows = liabilities.map(l => ({
                name: l.name, amount: l.amount, due_date: l.due_date,
                created_at: l.created_at, user_id: uid
            }));
            const { data, error } = await supabase.from('liabilities').insert(rows).select();
            if (!error && data) importedLiab = data.length;
        }

        res.json({
            success: true,
            imported: {
                accounts:     Object.keys(idMap).length,
                transactions: importedTx,
                liabilities:  importedLiab
            }
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ── USER SETTINGS (daily goal, future prefs) ──────────────────────────────────
app.get('/api/settings', requireAuth, async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('user_settings').select('*').eq('user_id', req.user.id).single();
        if (error && error.code !== 'PGRST116') throw error; // PGRST116 = no rows
        const base = data || {};
        res.json({
            daily_goal:          parseFloat(base.daily_goal) || 0,
            // Cash Flow module additions — defaulted so older rows (created before the
            // migration ran) behave exactly like a freshly-seeded settings row.
            daily_family_budget: base.daily_family_budget != null ? parseFloat(base.daily_family_budget) : 700,
            daily_fuel_budget:   base.daily_fuel_budget   != null ? parseFloat(base.daily_fuel_budget)   : 250,
            payroll_days:        (Array.isArray(base.payroll_days) && base.payroll_days.length) ? base.payroll_days : [15, 30],
            expected_payroll:    base.expected_payroll != null ? parseFloat(base.expected_payroll) : 6750,
            currency:            base.currency || 'PHP',
            notification_prefs:  base.notification_prefs || {
                payroll_tomorrow: true, fuel_low: true, buffer_goal: true,
                debt_due: true, cash_low: true, financial_risk: true
            }
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/settings', requireAuth, async (req, res) => {
    try {
        const uid   = req.user.id;
        const daily_goal = parseFloat(req.body.daily_goal) || 0;
        if (daily_goal < 0) return res.status(400).json({ error: 'daily_goal must be 0 or positive' });

        const payload = { user_id: uid, daily_goal, updated_at: new Date().toISOString() };

        // Cash Flow module additions — all optional so existing callers that only send
        // { daily_goal } keep working exactly as before.
        if (req.body.daily_family_budget !== undefined) payload.daily_family_budget = parseFloat(req.body.daily_family_budget) || 0;
        if (req.body.daily_fuel_budget   !== undefined) payload.daily_fuel_budget   = parseFloat(req.body.daily_fuel_budget)   || 0;
        if (req.body.payroll_days        !== undefined) payload.payroll_days        = (req.body.payroll_days || []).map(Number).filter(n => n >= 1 && n <= 31);
        if (req.body.expected_payroll    !== undefined) payload.expected_payroll    = parseFloat(req.body.expected_payroll) || 0;
        if (req.body.currency            !== undefined) payload.currency            = req.body.currency || 'PHP';
        if (req.body.notification_prefs  !== undefined) payload.notification_prefs  = req.body.notification_prefs;
        // Phase 1: Three-level buffer settings
        if (req.body.emergency_buffer_target !== undefined) payload.emergency_buffer_target = parseFloat(req.body.emergency_buffer_target) || 3000;
        if (req.body.operating_buffer_days   !== undefined) payload.operating_buffer_days   = parseInt(req.body.operating_buffer_days, 10) || 7;
        if (req.body.target_buffer           !== undefined) payload.target_buffer           = parseFloat(req.body.target_buffer) || 10000;

        const { data, error } = await supabase
            .from('user_settings')
            .upsert(payload, { onConflict: 'user_id' })
            .select();
        if (error) throw error;
        res.json(data[0]);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── TODAY'S GOAL PROGRESS ─────────────────────────────────────────────────────
// Counts income transactions today whose category name matches SFD or Lalamove
app.get('/api/goal/today', requireAuth, async (req, res) => {
    try {
        const uid = req.user.id;

        // 1. Get daily goal setting
        const { data: settings } = await supabase
            .from('user_settings').select('daily_goal').eq('user_id', uid).single();
        const dailyGoal = parseFloat(settings?.daily_goal) || 0;

        // 2. Find category IDs whose name is SFD or Lalamove (case-insensitive)
        const { data: cats } = await supabase
            .from('categories').select('id, name').eq('user_id', uid);
        const goalCatIds = (cats || [])
            .filter(function(c){ return /^(sfd|lalamove)$/i.test(c.name.trim()); })
            .map(function(c){ return c.id; });

        // 3. Sum today's income transactions that belong to those categories
        const now   = new Date();
        const start = new Date(now); start.setHours(0, 0, 0, 0);
        const end   = new Date(now); end.setHours(23, 59, 59, 999);

        let earnedToday = 0;
        if (goalCatIds.length > 0) {
            const { data: txs } = await supabase
                .from('transactions').select('amount')
                .eq('user_id', uid).eq('type', 'income')
                .in('category_id', goalCatIds)
                .gte('created_at', start.toISOString())
                .lte('created_at', end.toISOString());
            (txs || []).forEach(function(tx){ earnedToday += parseFloat(tx.amount) || 0; });
        }

        const remaining = Math.max(0, dailyGoal - earnedToday);
        const progress  = dailyGoal > 0 ? Math.min(100, Math.round((earnedToday / dailyGoal) * 100)) : 0;
        const done      = dailyGoal > 0 && earnedToday >= dailyGoal;

        res.json({ daily_goal: dailyGoal, earned_today: earnedToday, remaining, progress, done });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── CHECK UNCLAIMED ───────────────────────────────────────────────────────────
app.get('/api/unclaimed', requireAuth, async (req, res) => {
    try {
        const [
            { count: ac },
            { count: tc },
            { count: lc }
        ] = await Promise.all([
            supabase.from('accounts').select('*', { count: 'exact', head: true }).is('user_id', null),
            supabase.from('transactions').select('*', { count: 'exact', head: true }).is('user_id', null),
            supabase.from('liabilities').select('*', { count: 'exact', head: true }).is('user_id', null)
        ]);
        res.json({ total: (ac||0)+(tc||0)+(lc||0), accounts: ac||0, transactions: tc||0, liabilities: lc||0 });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ═══════════════════════════════════════════════════════════════════════════
// ███ CASH FLOW & FINANCIAL PLANNING MODULE ███
// Everything below is new and additive — it reuses the existing accounts,
// transactions, categories and liabilities tables wherever practical, and
// only introduces new tables (goals, goal_contributions, fuel_logs) where a
// genuinely new concept needed one. No existing route above this point was
// removed; a few were extended with optional fields (see comments above).
// ═══════════════════════════════════════════════════════════════════════════

// ── Shared Helpers ────────────────────────────────────────────────────────────
async function getCashflowSettings(uid) {
    const { data } = await supabase.from('user_settings').select('*').eq('user_id', uid).single();
    const base = data || {};
    return {
        daily_goal:             parseFloat(base.daily_goal) || 0,
        daily_family_budget:    base.daily_family_budget != null ? parseFloat(base.daily_family_budget) : 700,
        daily_fuel_budget:      base.daily_fuel_budget   != null ? parseFloat(base.daily_fuel_budget)   : 250,
        payroll_days:           (Array.isArray(base.payroll_days) && base.payroll_days.length) ? base.payroll_days.map(Number) : [15, 30],
        expected_payroll:       base.expected_payroll != null ? parseFloat(base.expected_payroll) : 6750,
        currency:               base.currency || 'PHP',
        notification_prefs:     base.notification_prefs || {
            payroll_tomorrow: true, fuel_low: true, buffer_goal: true,
            debt_due: true, cash_low: true, financial_risk: true
        },
        // Phase 1 — Three-level buffer targets (configurable from Settings)
        // DEFAULT: Emergency ₱3 000 | Operating 7 × daily cost | Target ₱10 000
        emergency_buffer_target: base.emergency_buffer_target != null ? parseFloat(base.emergency_buffer_target) : 3000,
        operating_buffer_days:   base.operating_buffer_days  != null ? parseInt(base.operating_buffer_days, 10)  : 7,
        target_buffer:           base.target_buffer          != null ? parseFloat(base.target_buffer)            : 10000
    };
}

function daysInMonth(y, m) { return new Date(y, m + 1, 0).getDate(); } // m is 0-indexed
function buildPayrollDate(y, m, day) {
    const d = Math.min(day, daysInMonth(y, m));
    return new Date(y, m, d, 0, 0, 0, 0);
}
// Next payroll date on/after `from`, given a list of days-of-month (e.g. [15, 30]).
function getNextPayroll(payrollDays, from) {
    const sorted = [...payrollDays].sort((a, b) => a - b);
    let y = from.getFullYear(), m = from.getMonth();
    for (let i = 0; i < 6; i++) {
        for (const day of sorted) {
            const d = buildPayrollDate(y, m, day);
            if (d >= from) return d;
        }
        m++; if (m > 11) { m = 0; y++; }
    }
    return null;
}
function isWorkday(d) { const day = d.getDay(); return day >= 1 && day <= 5; } // Mon–Fri
function monthAbbr(m) { return ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][parseInt(m, 10) - 1]; }
function ymd(d) { return new Date(d).toISOString().slice(0, 10); }

// Finds (case-insensitively) a category by exact name for the current user.
async function findCategoryByName(uid, name) {
    const { data } = await supabase.from('categories').select('*').eq('user_id', uid);
    return (data || []).find(c => (c.name || '').trim().toLowerCase() === name.toLowerCase()) || null;
}

// ── DEFAULT CATEGORIES ────────────────────────────────────────────────────────
// Idempotent: only inserts categories that don't already exist by name.
// Called automatically by the client when the Cash Flow hub is first opened.
app.post('/api/categories/seed-defaults', requireAuth, async (req, res) => {
    try {
        const uid = req.user.id;
        const defaults = [
            { name: 'Primary Job',     type: 'income'  },
            { name: 'SFD',             type: 'income'  },
            { name: 'Lalamove',        type: 'income'  },
            { name: 'Other Income',    type: 'income'  },
            { name: 'Family Expenses', type: 'expense' },
            { name: 'Fuel',            type: 'expense' },
            { name: 'Debt Payments',   type: 'expense' },
            { name: 'Food',            type: 'expense' },
            { name: 'Utilities',       type: 'expense' },
            { name: 'Transportation',  type: 'expense' },
            { name: 'Medical',         type: 'expense' },
            { name: 'Other',           type: 'expense' }
        ];
        const { data: existing } = await supabase.from('categories').select('name').eq('user_id', uid);
        const existingNames = new Set((existing || []).map(c => (c.name || '').trim().toLowerCase()));
        const toInsert = defaults
            .filter(d => !existingNames.has(d.name.toLowerCase()))
            .map(d => Object.assign({}, d, { user_id: uid }));
        if (toInsert.length) {
            const { error } = await supabase.from('categories').insert(toInsert);
            if (error) throw error;
        }
        res.json({ added: toInsert.length });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── CASH FLOW FORECAST ────────────────────────────────────────────────────────
// Single endpoint that powers the Dashboard KPI cards + the Forecast section.
// Every figure here is derived automatically — no manual calculation needed.
app.get('/api/cashflow/forecast', requireAuth, async (req, res) => {
    try {
        const uid = req.user.id;
        const settings = await getCashflowSettings(uid);

        const [{ data: accounts }, { data: liabilities }, { data: goals }, { data: cats }] = await Promise.all([
            supabase.from('accounts').select('*').eq('user_id', uid),
            supabase.from('liabilities').select('*').eq('user_id', uid),
            supabase.from('goals').select('*').eq('user_id', uid),
            supabase.from('categories').select('id, name').eq('user_id', uid)
        ]);

        const availableCash = (accounts || []).reduce((s, a) => s + (parseFloat(a.balance) || 0), 0);
        const remainingDebt = (liabilities || []).reduce((s, l) => s + (parseFloat(l.amount) || 0), 0);

        const bufferGoals = (goals || []).filter(g => g.type === 'buffer');
        const currentBuffer = bufferGoals.reduce((s, g) => s + (parseFloat(g.current_amount) || 0), 0);
        const bufferTarget  = bufferGoals.reduce((s, g) => s + (parseFloat(g.target_amount)  || 0), 0);
        const remainingBufferGoal = Math.max(0, bufferTarget - currentBuffer);

        const now = new Date(); now.setHours(0, 0, 0, 0);
        const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
        const monthEnd   = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);

        const { data: monthTx } = await supabase.from('transactions').select('type, amount')
            .eq('user_id', uid).gte('created_at', monthStart.toISOString()).lte('created_at', monthEnd.toISOString());

        let monthlyIncome = 0, monthlyExpense = 0;
        (monthTx || []).forEach(t => {
            const a = parseFloat(t.amount) || 0;
            if (t.type === 'income') monthlyIncome += a; else monthlyExpense += a;
        });
        const netCashFlow = monthlyIncome - monthlyExpense;

        // Trailing-30-day average daily variable income (SFD + Lalamove) — used to
        // project cash flow forward without requiring the user to type in a forecast.
        const variableCatIds = (cats || [])
            .filter(c => /^(sfd|lalamove)$/i.test((c.name || '').trim()))
            .map(c => c.id);
        const thirtyAgo = new Date(now); thirtyAgo.setDate(thirtyAgo.getDate() - 30);
        let avgDailyVariableIncome = 0;
        if (variableCatIds.length) {
            const { data: varTx } = await supabase.from('transactions').select('amount')
                .eq('user_id', uid).eq('type', 'income').in('category_id', variableCatIds)
                .gte('created_at', thirtyAgo.toISOString());
            const total = (varTx || []).reduce((s, t) => s + (parseFloat(t.amount) || 0), 0);
            avgDailyVariableIncome = total / 30;
        }

        const nextPayroll = getNextPayroll(settings.payroll_days, now);
        const daysUntilPayroll = nextPayroll ? Math.round((nextPayroll - now) / 86400000) : null;

        const dailyRequirement = (date) => settings.daily_family_budget + (isWorkday(date) ? settings.daily_fuel_budget : 0);

        // Day-by-day simulation: walk forward from today, applying the projected
        // variable income (workdays only) against the daily requirement, to find
        // (a) the net position right before payroll, and (b) the first day cash
        // would go negative, if any, within a 90-day horizon.
        const horizon = Math.min(90, Math.max(daysUntilPayroll || 1, 1));
        let totalRequiredUntilPayroll = 0, totalIncomeUntilPayroll = 0;
        let simCash = availableCash, runOutDay = null;
        for (let i = 0; i < 90; i++) {
            const d = new Date(now); d.setDate(d.getDate() + i);
            const req = dailyRequirement(d);
            const inc = isWorkday(d) ? avgDailyVariableIncome : 0;
            if (i < horizon) { totalRequiredUntilPayroll += req; totalIncomeUntilPayroll += inc; }
            simCash += inc - req;
            if (runOutDay === null && simCash < 0) runOutDay = i + 1;
            if (i >= horizon - 1 && runOutDay !== null) break;
        }

        const cashRemainingBeforeNextPayroll = availableCash - totalRequiredUntilPayroll + totalIncomeUntilPayroll;
        const expectedBufferGrowth = Math.max(0, totalIncomeUntilPayroll - totalRequiredUntilPayroll);
        const expectedSurplus = cashRemainingBeforeNextPayroll + (nextPayroll ? settings.expected_payroll : 0) - dailyRequirement(nextPayroll || now);

        const tomorrow = new Date(now); tomorrow.setDate(tomorrow.getDate() + 1);
        const todaysAvailableCash = availableCash;
        const tomorrowsRequiredCash = dailyRequirement(tomorrow);
        const dailyCashRequirement  = dailyRequirement(now);

        let health = 'green';
        let healthMessage = 'Cash is sufficient.';
        if (runOutDay !== null && daysUntilPayroll !== null && runOutDay <= daysUntilPayroll) {
            health = 'red';
            healthMessage = 'Risk of running out of cash before your next payroll.';
        } else if (cashRemainingBeforeNextPayroll < dailyCashRequirement * 2) {
            health = 'yellow';
            healthMessage = 'Cash is tight before your next payroll — monitor spending.';
        }

        res.json({
            kpis: {
                availableCash, currentBuffer, remainingBufferGoal, remainingDebt,
                nextPayrollDate: nextPayroll ? ymd(nextPayroll) : null,
                daysUntilPayroll,
                fuelBudget: settings.daily_fuel_budget,
                dailyCashRequirement,
                monthlyIncome, monthlyExpense, netCashFlow
            },
            forecast: {
                todaysAvailableCash, tomorrowsRequiredCash,
                cashRemainingBeforeNextPayroll,
                estimatedDaysUntilCashRunsOut: runOutDay,
                expectedBufferGrowth, expectedSurplus,
                avgDailyVariableIncome
            },
            health, healthMessage,
            settings
        });
    } catch (e) {
        console.error('Forecast error:', e);
        res.status(500).json({ error: e.message });
    }
});

// ── PAYROLL PLANNER ───────────────────────────────────────────────────────────
app.get('/api/cashflow/payroll', requireAuth, async (req, res) => {
    try {
        const uid = req.user.id;
        const settings = await getCashflowSettings(uid);
        const now = new Date(); now.setHours(0, 0, 0, 0);
        const sorted = [...settings.payroll_days].sort((a, b) => a - b);

        const nextPayroll = getNextPayroll(sorted, now);
        const daysUntilPayroll = nextPayroll ? Math.round((nextPayroll - now) / 86400000) : null;

        // Previous payroll date (start of the current pay period).
        const candidates = [];
        for (let off = -2; off <= 0; off++) {
            const mm = now.getMonth() + off;
            const yy = now.getFullYear() + Math.floor(mm / 12);
            const adjM = ((mm % 12) + 12) % 12;
            sorted.forEach(day => candidates.push(buildPayrollDate(yy, adjM, day)));
        }
        candidates.sort((a, b) => a - b);
        const past = candidates.filter(d => d < now);
        const periodStart = past.length ? past[past.length - 1] : new Date(now.getFullYear(), now.getMonth(), 1);

        const pjCat = await findCategoryByName(uid, 'Primary Job');

        let actualPayroll = 0, history = [];
        if (pjCat) {
            const { data: pjTx } = await supabase.from('transactions').select('amount, created_at')
                .eq('user_id', uid).eq('type', 'income').eq('category_id', pjCat.id)
                .order('created_at', { ascending: false });

            (pjTx || []).forEach(t => {
                const d = new Date(t.created_at);
                if (d >= periodStart && d <= now) actualPayroll += parseFloat(t.amount) || 0;
            });

            const periods = {};
            (pjTx || []).forEach(t => {
                const d = new Date(t.created_at);
                const half = d.getDate() <= 15 ? '1' : '2';
                const key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + half;
                periods[key] = (periods[key] || 0) + (parseFloat(t.amount) || 0);
            });
            history = Object.keys(periods)
                .sort((a, b) => b.localeCompare(a))
                .slice(0, 6)
                .map(k => {
                    const [y, m, half] = k.split('-');
                    return { period: k, label: (half === '1' ? '1st–15th ' : '16th–end ') + monthAbbr(m) + ' ' + y, amount: periods[k] };
                });
        }

        const recentAmounts = history.slice(0, 3).map(h => h.amount).filter(a => a > 0);
        const expectedPayroll = recentAmounts.length
            ? recentAmounts.reduce((s, a) => s + a, 0) / recentAmounts.length
            : settings.expected_payroll;

        res.json({
            nextPayrollDate: nextPayroll ? ymd(nextPayroll) : null,
            daysUntilPayroll,
            periodStart: ymd(periodStart),
            expectedPayroll, actualPayroll, history,
            payrollDays: sorted
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GOALS (Operating Buffer + Goal Planner) ───────────────────────────────────
// type = 'buffer' for the Operating Buffer milestones, 'savings' for the Goal Planner.
app.get('/api/goals', requireAuth, async (req, res) => {
    try {
        let q = supabase.from('goals').select('*').eq('user_id', req.user.id).order('created_at', { ascending: true });
        if (req.query.type) q = q.eq('type', req.query.type);
        const { data: goals, error } = await q;
        if (error) throw error;

        const { data: contributions } = await supabase.from('goal_contributions')
            .select('goal_id, amount, created_at').eq('user_id', req.user.id);

        const enriched = (goals || []).map(g => {
            const target  = parseFloat(g.target_amount)  || 0;
            const current = parseFloat(g.current_amount) || 0;
            const remaining = Math.max(0, target - current);
            const progress  = target > 0 ? Math.min(100, Math.round((current / target) * 100)) : 0;

            // Estimated completion date — derived automatically from the goal's own
            // contribution history (average ₱/day between first and last deposit).
            const gc = (contributions || [])
                .filter(c => c.goal_id === g.id && parseFloat(c.amount) > 0)
                .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
            let estimatedCompletionDate = null, daysRemaining = null;
            if (gc.length >= 2 && remaining > 0) {
                const spanDays = (new Date(gc[gc.length - 1].created_at) - new Date(gc[0].created_at)) / 86400000;
                const totalContributed = gc.reduce((s, c) => s + parseFloat(c.amount), 0);
                const dailyRate = spanDays > 0 ? totalContributed / spanDays : 0;
                if (dailyRate > 0) {
                    daysRemaining = Math.ceil(remaining / dailyRate);
                    const d = new Date(); d.setDate(d.getDate() + daysRemaining);
                    estimatedCompletionDate = ymd(d);
                }
            }
            return Object.assign({}, g, { target_amount: target, current_amount: current, remaining, progress, estimatedCompletionDate, daysRemaining });
        });
        res.json(enriched);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/goals', requireAuth, async (req, res) => {
    try {
        const { name, type, target_amount, target_date } = req.body;
        if (!name?.trim()) return res.status(400).json({ error: 'name is required' });
        if (!['buffer', 'savings'].includes(type)) return res.status(400).json({ error: 'type must be "buffer" or "savings"' });
        if (isNaN(parseFloat(target_amount)) || parseFloat(target_amount) <= 0) return res.status(400).json({ error: 'target_amount must be a positive number' });

        const payload = { name: name.trim(), type, target_amount: parseFloat(target_amount), current_amount: 0, user_id: req.user.id };
        if (target_date) payload.target_date = target_date;

        const { data, error } = await supabase.from('goals').insert([payload]).select();
        if (error) throw error;
        res.status(201).json(data[0]);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/goals/:id', requireAuth, async (req, res) => {
    try {
        const { name, target_amount, target_date } = req.body;
        const updates = {};
        if (name !== undefined) {
            if (!name.trim()) return res.status(400).json({ error: 'name is required' });
            updates.name = name.trim();
        }
        if (target_amount !== undefined) {
            if (isNaN(parseFloat(target_amount)) || parseFloat(target_amount) <= 0) return res.status(400).json({ error: 'invalid target_amount' });
            updates.target_amount = parseFloat(target_amount);
        }
        if (target_date !== undefined) updates.target_date = target_date || null;

        const { data, error } = await supabase.from('goals').update(updates).eq('id', req.params.id).eq('user_id', req.user.id).select();
        if (error) throw error;
        if (!data?.length) return res.status(404).json({ error: 'Goal not found' });
        res.json(data[0]);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/goals/:id', requireAuth, async (req, res) => {
    try {
        await supabase.from('goal_contributions').delete().eq('goal_id', req.params.id).eq('user_id', req.user.id);
        const { error } = await supabase.from('goals').delete().eq('id', req.params.id).eq('user_id', req.user.id);
        if (error) throw error;
        res.status(204).send();
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Deposit (positive amount) or withdraw (negative amount) from a goal.
app.post('/api/goals/:id/contribute', requireAuth, async (req, res) => {
    try {
        const uid = req.user.id, { id } = req.params;
        const amount = parseFloat(req.body.amount);
        if (isNaN(amount) || amount === 0) return res.status(400).json({ error: 'amount must be a non-zero number' });

        const { data: goalRows, error: gErr } = await supabase.from('goals').select('*').eq('id', id).eq('user_id', uid);
        if (gErr) throw gErr;
        if (!goalRows?.length) return res.status(404).json({ error: 'Goal not found' });

        const newAmount = Math.max(0, (parseFloat(goalRows[0].current_amount) || 0) + amount);
        const { data, error } = await supabase.from('goals').update({ current_amount: newAmount }).eq('id', id).eq('user_id', uid).select();
        if (error) throw error;

        await supabase.from('goal_contributions').insert([{ goal_id: id, user_id: uid, amount }]);
        res.json(data[0]);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/goals/:id/contributions', requireAuth, async (req, res) => {
    try {
        const { data, error } = await supabase.from('goal_contributions').select('*')
            .eq('goal_id', req.params.id).eq('user_id', req.user.id).order('created_at', { ascending: false });
        if (error) throw error;
        res.json(data || []);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DEBT MANAGER (extends the existing liabilities table) ────────────────────
app.put('/api/liabilities/:id', requireAuth, async (req, res) => {
    try {
        const { name, amount, due_date, original_amount, monthly_payment, due_day } = req.body;
        const updates = {};
        if (name !== undefined) {
            if (!name.trim()) return res.status(400).json({ error: 'name is required' });
            updates.name = name.trim();
        }
        if (amount !== undefined) {
            if (isNaN(parseFloat(amount)) || parseFloat(amount) < 0) return res.status(400).json({ error: 'invalid amount' });
            updates.amount = parseFloat(amount);
        }
        if (due_date !== undefined)        updates.due_date        = due_date || null;
        if (original_amount !== undefined) updates.original_amount = original_amount !== '' ? parseFloat(original_amount) : null;
        if (monthly_payment !== undefined) updates.monthly_payment = monthly_payment !== '' ? parseFloat(monthly_payment) : null;
        if (due_day !== undefined)         updates.due_day         = due_day !== '' ? parseInt(due_day) : null;

        const { data, error } = await supabase.from('liabilities').update(updates).eq('id', req.params.id).eq('user_id', req.user.id).select();
        if (error) throw error;
        if (!data?.length) return res.status(404).json({ error: 'Liability not found' });
        res.json(data[0]);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Record a debt payment: creates a "Debt Payments" transaction, decrements the
// liability balance, and decrements the paying account's balance, atomically-ish.
app.post('/api/liabilities/:id/pay', requireAuth, async (req, res) => {
    try {
        const uid = req.user.id, { id } = req.params;
        const { account_id, amount, description } = req.body;
        if (!account_id) return res.status(400).json({ error: 'account_id is required' });
        if (isNaN(parseFloat(amount)) || parseFloat(amount) <= 0) return res.status(400).json({ error: 'amount must be a positive number' });
        const amt = parseFloat(amount);

        const { data: liabRows, error: lErr } = await supabase.from('liabilities').select('*').eq('id', id).eq('user_id', uid);
        if (lErr) throw lErr;
        if (!liabRows?.length) return res.status(404).json({ error: 'Liability not found' });
        const liab = liabRows[0];

        const { data: accRows, error: aErr } = await supabase.from('accounts').select('*').eq('id', account_id).eq('user_id', uid);
        if (aErr) throw aErr;
        if (!accRows?.length) return res.status(404).json({ error: 'Account not found' });
        const acc = accRows[0];

        let debtCat = await findCategoryByName(uid, 'Debt Payments');
        if (!debtCat) {
            const { data: newCat, error: cErr } = await supabase.from('categories')
                .insert([{ name: 'Debt Payments', type: 'expense', user_id: uid }]).select();
            if (cErr) throw cErr;
            debtCat = newCat[0];
        }

        const { data: tx, error: tErr } = await supabase.from('transactions').insert([{
            account_id, type: 'expense', amount: amt,
            description: description || ('Payment: ' + liab.name),
            category_id: debtCat.id, liability_id: id, user_id: uid
        }]).select();
        if (tErr) throw tErr;

        const newBalance = Math.max(0, parseFloat(liab.amount) - amt);
        await Promise.all([
            supabase.from('liabilities').update({ amount: newBalance }).eq('id', id).eq('user_id', uid),
            supabase.from('accounts').update({ balance: parseFloat(acc.balance) - amt }).eq('id', account_id).eq('user_id', uid)
        ]);

        res.status(201).json({ transaction: tx[0], newBalance });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/liabilities/:id/payments', requireAuth, async (req, res) => {
    try {
        const { data, error } = await supabase.from('transactions').select('*, accounts(name)')
            .eq('liability_id', req.params.id).eq('user_id', req.user.id).order('created_at', { ascending: false });
        if (error) throw error;
        res.json(data || []);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Progress + estimated payoff date for every liability — automatic, no manual math.
app.get('/api/liabilities/summary', requireAuth, async (req, res) => {
    try {
        const { data: liabs, error } = await supabase.from('liabilities').select('*').eq('user_id', req.user.id);
        if (error) throw error;
        const enriched = (liabs || []).map(l => {
            const original = parseFloat(l.original_amount != null ? l.original_amount : l.amount) || 0;
            const current  = parseFloat(l.amount) || 0;
            const paid     = Math.max(0, original - current);
            const progress = original > 0 ? Math.min(100, Math.round((paid / original) * 100)) : 0;
            let estimatedPayoffDate = null;
            if (l.monthly_payment && parseFloat(l.monthly_payment) > 0 && current > 0) {
                const months = Math.ceil(current / parseFloat(l.monthly_payment));
                const d = new Date(); d.setMonth(d.getMonth() + months);
                estimatedPayoffDate = ymd(d);
            }
            return Object.assign({}, l, { original_amount: original, paid, progress, estimatedPayoffDate });
        });
        res.json(enriched);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── FUEL TRACKER ───────────────────────────────────────────────────────────────
app.get('/api/fuel', requireAuth, async (req, res) => {
    try {
        const { start, end } = req.query;
        let q = supabase.from('fuel_logs').select('*').eq('user_id', req.user.id).order('log_date', { ascending: false });
        if (start && end) q = q.gte('log_date', start).lte('log_date', end);
        const { data, error } = await q;
        if (error) throw error;
        res.json(data || []);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/fuel', requireAuth, async (req, res) => {
    try {
        const { log_date, liters, cost, odometer, station, notes, transaction_id } = req.body;
        if (isNaN(parseFloat(cost)) || parseFloat(cost) <= 0) return res.status(400).json({ error: 'cost must be a positive number' });
        const payload = {
            user_id: req.user.id,
            log_date: log_date || ymd(new Date()),
            cost: parseFloat(cost),
            liters:   (liters   !== undefined && liters   !== '') ? parseFloat(liters)   : null,
            odometer: (odometer !== undefined && odometer !== '') ? parseFloat(odometer) : null,
            station: station || null,
            notes:   notes   || null,
            // Links this fuel log back to the expense transaction created by the client,
            // so deleteFuelLog can cascade-delete both records in one action.
            transaction_id: transaction_id || null
        };
        const { data, error } = await supabase.from('fuel_logs').insert([payload]).select();
        if (error) throw error;
        res.status(201).json(data[0]);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/fuel/:id', requireAuth, async (req, res) => {
    try {
        const { log_date, liters, cost, odometer, station, notes } = req.body;
        if (isNaN(parseFloat(cost)) || parseFloat(cost) <= 0) return res.status(400).json({ error: 'cost must be a positive number' });
        const updates = {
            log_date: log_date || ymd(new Date()),
            cost: parseFloat(cost),
            liters:   (liters   !== undefined && liters   !== '') ? parseFloat(liters)   : null,
            odometer: (odometer !== undefined && odometer !== '') ? parseFloat(odometer) : null,
            station: station || null,
            notes:   notes   || null
        };
        const { data, error } = await supabase.from('fuel_logs').update(updates).eq('id', req.params.id).eq('user_id', req.user.id).select();
        if (error) throw error;
        if (!data?.length) return res.status(404).json({ error: 'Fuel log not found' });
        res.json(data[0]);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/fuel/:id', requireAuth, async (req, res) => {
    try {
        const { error } = await supabase.from('fuel_logs').delete().eq('id', req.params.id).eq('user_id', req.user.id);
        if (error) throw error;
        res.status(204).send();
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/fuel/stats', requireAuth, async (req, res) => {
    try {
        const uid = req.user.id;
        const { data: logsRaw, error } = await supabase.from('fuel_logs').select('*').eq('user_id', uid).order('log_date', { ascending: false });
        if (error) throw error;
        const list = logsRaw || [];
        const avgCost = list.length ? list.reduce((s, l) => s + (parseFloat(l.cost) || 0), 0) / list.length : 0;

        const now = new Date();
        const weekStart = new Date(now); weekStart.setDate(now.getDate() - now.getDay()); weekStart.setHours(0, 0, 0, 0);
        const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

        const fuelPerWeek  = list.filter(l => new Date(l.log_date) >= weekStart).reduce((s, l) => s + (parseFloat(l.cost) || 0), 0);
        const fuelPerMonth = list.filter(l => new Date(l.log_date) >= monthStart).reduce((s, l) => s + (parseFloat(l.cost) || 0), 0);

        let workdaysElapsed = 0;
        for (let d = new Date(monthStart); d <= now; d.setDate(d.getDate() + 1)) {
            if (isWorkday(d)) workdaysElapsed++;
        }
        const avgCostPerWorkday = workdaysElapsed > 0 ? fuelPerMonth / workdaysElapsed : 0;

        res.json({ avgCost, fuelPerWeek, fuelPerMonth, avgCostPerWorkday, totalLogs: list.length });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── INCOME / EXPENSE TRACKING (built on top of existing transactions+categories) ──
app.get('/api/income/summary', requireAuth, async (req, res) => {
    try {
        const uid = req.user.id;
        const { data: cats } = await supabase.from('categories').select('*').eq('user_id', uid).in('type', ['income', 'both']);
        const { data: tx }   = await supabase.from('transactions').select('amount, category_id, created_at').eq('user_id', uid).eq('type', 'income');

        const now = new Date();
        const dayStart = new Date(now); dayStart.setHours(0, 0, 0, 0);
        const weekStart = new Date(dayStart); weekStart.setDate(dayStart.getDate() - dayStart.getDay());
        const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
        const yearStart  = new Date(now.getFullYear(), 0, 1);
        const sumSince = (date) => (tx || []).filter(t => new Date(t.created_at) >= date).reduce((s, t) => s + (parseFloat(t.amount) || 0), 0);

        const bySource = {};
        (tx || []).forEach(t => {
            const cat = (cats || []).find(c => c.id === t.category_id);
            const label = cat ? cat.name : 'Uncategorized';
            bySource[label] = (bySource[label] || 0) + (parseFloat(t.amount) || 0);
        });

        res.json({
            daily: sumSince(dayStart), weekly: sumSince(weekStart),
            monthly: sumSince(monthStart), yearly: sumSince(yearStart),
            bySource
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/expenses/summary', requireAuth, async (req, res) => {
    try {
        const uid = req.user.id;
        const { data: cats } = await supabase.from('categories').select('*').eq('user_id', uid);
        const { data: tx }   = await supabase.from('transactions').select('amount, category_id, created_at').eq('user_id', uid).eq('type', 'expense');

        const now = new Date();
        const dayStart = new Date(now); dayStart.setHours(0, 0, 0, 0);
        const weekStart = new Date(dayStart); weekStart.setDate(dayStart.getDate() - dayStart.getDay());
        const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
        const yearStart  = new Date(now.getFullYear(), 0, 1);
        const sumSince = (date) => (tx || []).filter(t => new Date(t.created_at) >= date).reduce((s, t) => s + (parseFloat(t.amount) || 0), 0);

        const byCategory = {};
        (tx || []).forEach(t => {
            const cat = (cats || []).find(c => c.id === t.category_id);
            const label = cat ? cat.name : 'Uncategorized';
            byCategory[label] = (byCategory[label] || 0) + (parseFloat(t.amount) || 0);
        });
        const total = Object.values(byCategory).reduce((s, v) => s + v, 0);
        const distribution = Object.keys(byCategory)
            .map(k => ({ category: k, amount: byCategory[k], percent: total > 0 ? Math.round((byCategory[k] / total) * 100) : 0 }))
            .sort((a, b) => b.amount - a.amount);

        res.json({
            daily: sumSince(dayStart), weekly: sumSince(weekStart),
            monthly: sumSince(monthStart), yearly: sumSince(yearStart),
            distribution
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── CALENDAR ───────────────────────────────────────────────────────────────────
app.get('/api/calendar', requireAuth, async (req, res) => {
    try {
        const uid = req.user.id;
        const month = req.query.month; // 'YYYY-MM'
        let y, m;
        if (month && /^\d{4}-\d{2}$/.test(month)) { [y, m] = month.split('-').map(Number); m -= 1; }
        else { const now = new Date(); y = now.getFullYear(); m = now.getMonth(); }
        const start = new Date(y, m, 1, 0, 0, 0, 0);
        const end   = new Date(y, m + 1, 0, 23, 59, 59, 999);

        const [{ data: tx }, { data: fuel }, { data: contributions }, { data: cats }] = await Promise.all([
            supabase.from('transactions').select('*').eq('user_id', uid).gte('created_at', start.toISOString()).lte('created_at', end.toISOString()),
            supabase.from('fuel_logs').select('*').eq('user_id', uid).gte('log_date', ymd(start)).lte('log_date', ymd(end)),
            supabase.from('goal_contributions').select('*').eq('user_id', uid).gte('created_at', start.toISOString()).lte('created_at', end.toISOString()),
            supabase.from('categories').select('*').eq('user_id', uid)
        ]);

        const debtCat = (cats || []).find(c => /^debt payments$/i.test((c.name || '').trim()));
        const pjCat   = (cats || []).find(c => /^primary job$/i.test((c.name || '').trim()));

        const days = {};
        const ensure = (key) => { if (!days[key]) days[key] = { income: 0, expense: 0, fuel: 0, debtPayments: 0, payroll: 0, bufferDeposits: 0, transactions: [] }; return days[key]; };

        (tx || []).forEach(t => {
            const key = ymd(t.created_at);
            const day = ensure(key);
            const amt = parseFloat(t.amount) || 0;
            if (t.type === 'income') {
                day.income += amt;
                if (pjCat && t.category_id === pjCat.id) day.payroll += amt;
            } else {
                day.expense += amt;
                if (debtCat && t.category_id === debtCat.id) day.debtPayments += amt;
            }
            day.transactions.push(t);
        });
        (fuel || []).forEach(f => { ensure(f.log_date).fuel += parseFloat(f.cost) || 0; });
        (contributions || []).forEach(c => {
            if (parseFloat(c.amount) > 0) ensure(ymd(c.created_at)).bufferDeposits += parseFloat(c.amount);
        });

        // Net Cash = income minus expense. (Fuel is shown separately for visibility;
        // if a fuel purchase was *also* logged as a categorized expense transaction,
        // it's already counted once in `expense` — fuel_logs are not double-subtracted.)
        const result = Object.keys(days)
            .map(key => Object.assign({ date: key }, days[key], { netCash: days[key].income - days[key].expense }))
            .sort((a, b) => a.date.localeCompare(b.date));

        res.json({ month: y + '-' + String(m + 1).padStart(2, '0'), days: result });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── NOTIFICATIONS ──────────────────────────────────────────────────────────────
// Computed live on every request — always reflects current data, nothing to sync.
app.get('/api/notifications', requireAuth, async (req, res) => {
    try {
        const uid = req.user.id;
        const settings = await getCashflowSettings(uid);
        const prefs = settings.notification_prefs;
        const notifications = [];
        const now = new Date(); now.setHours(0, 0, 0, 0);

        const nextPayroll = getNextPayroll(settings.payroll_days, now);

        if (prefs.payroll_tomorrow && nextPayroll) {
            const days = Math.round((nextPayroll - now) / 86400000);
            if (days === 1) {
                notifications.push({ type: 'payroll_tomorrow', severity: 'info', title: 'Payroll Tomorrow',
                    message: 'Your next payroll arrives tomorrow (' + ymd(nextPayroll) + ').' });
            }
        }

        if (prefs.fuel_low) {
            const today = ymd(now);
            const { data: todaysFuel } = await supabase.from('fuel_logs').select('cost').eq('user_id', uid).eq('log_date', today);
            const spentToday = (todaysFuel || []).reduce((s, f) => s + (parseFloat(f.cost) || 0), 0);
            if (spentToday > settings.daily_fuel_budget) {
                notifications.push({ type: 'fuel_low', severity: 'warning', title: 'Fuel Budget Running Low',
                    message: "Today's fuel spend (₱" + spentToday.toFixed(2) + ') is over your ₱' + settings.daily_fuel_budget.toFixed(2) + ' daily budget.' });
            }
        }

        if (prefs.buffer_goal) {
            const { data: goals } = await supabase.from('goals').select('*').eq('user_id', uid).eq('type', 'buffer');
            (goals || []).forEach(g => {
                const target = parseFloat(g.target_amount) || 0;
                if (target > 0 && parseFloat(g.current_amount) >= target) {
                    notifications.push({ type: 'buffer_goal', severity: 'success', title: 'Buffer Goal Achieved',
                        message: '"' + g.name + '" reached its target of ₱' + target.toFixed(2) + '.' });
                }
            });
        }

        if (prefs.debt_due) {
            const { data: liabs } = await supabase.from('liabilities').select('*').eq('user_id', uid);
            (liabs || []).forEach(l => {
                if (!l.due_date) return;
                const due = new Date(l.due_date + 'T00:00:00');
                const days = Math.floor((due - now) / 86400000);
                if (days >= 0 && days <= 3) {
                    notifications.push({ type: 'debt_due', severity: days <= 1 ? 'urgent' : 'warning', title: 'Debt Due Soon',
                        message: l.name + ' (₱' + parseFloat(l.amount).toFixed(2) + ') due ' + (days === 0 ? 'today' : 'in ' + days + ' day(s)') + '.' });
                }
            });
        }

        if (prefs.cash_low || prefs.financial_risk) {
            const { data: accounts } = await supabase.from('accounts').select('balance').eq('user_id', uid);
            const availableCash = (accounts || []).reduce((s, a) => s + (parseFloat(a.balance) || 0), 0);
            const todayReq = settings.daily_family_budget + (isWorkday(now) ? settings.daily_fuel_budget : 0);

            if (prefs.cash_low && availableCash < todayReq) {
                notifications.push({ type: 'cash_low', severity: 'urgent', title: 'Cash Running Low',
                    message: 'Available cash (₱' + availableCash.toFixed(2) + ") is below today's requirement (₱" + todayReq.toFixed(2) + ').' });
            }
            if (prefs.financial_risk && nextPayroll) {
                const daysUntilPayroll = Math.round((nextPayroll - now) / 86400000);
                const projectedDeficit = availableCash - (todayReq * daysUntilPayroll);
                if (projectedDeficit < 0) {
                    notifications.push({ type: 'financial_risk', severity: 'urgent', title: 'Upcoming Financial Risk',
                        message: 'At current spending, cash may run out before your next payroll on ' + ymd(nextPayroll) + '.' });
                }
            }
        }

        res.json(notifications);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── REPORTS (data endpoint — client builds the PDF/Excel/CSV export) ─────────
app.get('/api/reports', requireAuth, async (req, res) => {
    try {
        const uid = req.user.id;
        const { start, end } = req.query;
        if (!start || !end) return res.status(400).json({ error: 'start and end are required' });

        const [{ data: tx }, { data: fuel }, { data: cats }] = await Promise.all([
            supabase.from('transactions').select('*, accounts(name)').eq('user_id', uid)
                .gte('created_at', start).lte('created_at', end).order('created_at', { ascending: true }),
            supabase.from('fuel_logs').select('*').eq('user_id', uid)
                .gte('log_date', start.slice(0, 10)).lte('log_date', end.slice(0, 10)).order('log_date', { ascending: true }),
            supabase.from('categories').select('*').eq('user_id', uid)
        ]);

        let income = 0, expense = 0;
        (tx || []).forEach(t => { const a = parseFloat(t.amount) || 0; if (t.type === 'income') income += a; else expense += a; });
        const fuelTotal = (fuel || []).reduce((s, f) => s + (parseFloat(f.cost) || 0), 0);

        res.json({
            range: { start, end },
            summary: { income, expense, net: income - expense, fuelTotal },
            transactions: (tx || []).map(t => Object.assign({}, t, {
                category_name: (cats || []).find(c => c.id === t.category_id)?.name || ''
            })),
            fuelLogs: fuel || []
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════
// ███ FINANCIAL ANALYSIS ENGINE — PHASE 1–4 ███
//
// MIGRATION (additive — run once in Supabase SQL Editor):
//
//  -- Phase 1: Three-level buffer targets on user_settings
//  ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS emergency_buffer_target DECIMAL(12,2) DEFAULT 3000;
//  ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS operating_buffer_days   INTEGER       DEFAULT 7;
//  ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS target_buffer           DECIMAL(12,2) DEFAULT 10000;
//
//  -- Phase 2: Separate recurring bills from personal debts on existing liabilities table.
//  --          Default = 'debt' so every existing row keeps working without any data change.
//  ALTER TABLE liabilities ADD COLUMN IF NOT EXISTS liability_type TEXT NOT NULL DEFAULT 'debt';
//  --  liability_type = 'bill'  → recurring monthly expense (Meralco, Water, Internet …)
//  --  liability_type = 'debt'  → personal debt with a decreasing balance (existing behaviour)
//
// ═══════════════════════════════════════════════════════════════════════════

// ── Phase 2 helper: next calendar date a bill's due_day falls on ─────────────
/**
 * Given a day-of-month (1–31) and a reference date, return the next Date on
 * which that day occurs (today included if today is that day).
 * @param {number} dueDay - day of month (1–31)
 * @param {Date}   from   - reference date (time set to 00:00)
 * @returns {Date}
 */
function getNextDueDate(dueDay, from) {
    const clamp = (y, m) => Math.min(dueDay, daysInMonth(y, m));
    const thisMonthDate = new Date(from.getFullYear(), from.getMonth(), clamp(from.getFullYear(), from.getMonth()));
    if (thisMonthDate >= from) return thisMonthDate;
    const nm = new Date(from.getFullYear(), from.getMonth() + 1, 1);
    return new Date(nm.getFullYear(), nm.getMonth(), clamp(nm.getFullYear(), nm.getMonth()));
}

// ── Phase 4: Financial Health Score ──────────────────────────────────────────
/**
 * Computes a 0–100 health score from six independent factors.
 * Each factor is weighted according to its importance to daily cash-flow resilience.
 *
 * @typedef {{ score:number, max:number, label:string }} Factor
 * @typedef {{ score:number, label:string, color:string, factors:Object.<string,Factor> }} HealthScore
 *
 * @param {{
 *   availableCash:          number,
 *   remainingDebt:          number,
 *   avgDailyIncome:         number,
 *   dailyOperatingCost:     number,
 *   emergencyBufferTarget:  number,
 *   operatingBufferTarget:  number,
 *   currentBuffer:          number,
 *   upcomingBillsTotal:     number,
 *   dailySavingsCapacity:   number,
 *   incomeStabilityPct:     number   // 0–100 from coefficient-of-variation analysis
 * }} p
 * @returns {HealthScore}
 */
function computeHealthScore(p) {
    // Factor 1 — Debt Ratio (20 pts)
    // Ratio of remaining debt to available cash. Lower = better.
    // debtRatio > 5 → 0 pts; debtRatio = 0 → 20 pts.
    const debtRatio  = p.availableCash > 0 ? Math.min(p.remainingDebt / p.availableCash, 5) : (p.remainingDebt > 0 ? 5 : 0);
    const debtScore  = Math.round(Math.max(0, 20 * (1 - debtRatio / 5)));

    // Factor 2 — Emergency Buffer funded (15 pts)
    // Does available cash cover the ₱3 000 emergency target?
    const emergencyScore = Math.round(15 * Math.min(1, p.availableCash / Math.max(p.emergencyBufferTarget, 1)));

    // Factor 3 — Operating Buffer funded (15 pts)
    // Does the buffer goal cover 7 × daily operating cost?
    const operatingScore = Math.round(15 * Math.min(1, p.currentBuffer / Math.max(p.operatingBufferTarget, 1)));

    // Factor 4 — Upcoming bills covered (20 pts)
    // Can available cash cover bills due in the next 30 days?
    const billsScore = p.upcomingBillsTotal === 0
        ? 20
        : Math.round(20 * Math.min(1, p.availableCash / Math.max(p.upcomingBillsTotal, 1)));

    // Factor 5 — Income stability (15 pts)
    // Based on the coefficient of variation of daily income — passed in as 0–100 %.
    const stabilityScore = Math.round(15 * p.incomeStabilityPct / 100);

    // Factor 6 — Daily savings capacity (15 pts)
    // ₱700/day = excellent (full marks). Negative = 0.
    const capacityScore = Math.round(15 * Math.min(1, Math.max(0, p.dailySavingsCapacity) / 700));

    const total = debtScore + emergencyScore + operatingScore + billsScore + stabilityScore + capacityScore;

    let label, color;
    if      (total >= 75) { label = 'Excellent'; color = 'green';  }
    else if (total >= 55) { label = 'Good';      color = 'blue';   }
    else if (total >= 35) { label = 'Warning';   color = 'yellow'; }
    else                  { label = 'Critical';  color = 'red';    }

    return {
        score: total, label, color,
        factors: {
            debtRatio:      { score: debtScore,     max: 20, label: 'Debt Ratio'       },
            emergency:      { score: emergencyScore, max: 15, label: 'Emergency Buffer' },
            operating:      { score: operatingScore, max: 15, label: 'Operating Buffer' },
            billsCoverage:  { score: billsScore,     max: 20, label: 'Bills Coverage'   },
            stability:      { score: stabilityScore, max: 15, label: 'Income Stability' },
            savings:        { score: capacityScore,  max: 15, label: 'Savings Capacity' }
        }
    };
}

// ── Phase 1: Central Financial Calculation Engine ─────────────────────────────
/**
 * Single source of truth for all financial KPIs.
 * Every number exposed by /api/engine/snapshot flows through here.
 * No endpoint or UI component should re-derive these values independently.
 *
 * @param {string} uid - authenticated user id
 * @returns {Promise<Object>} snapshot
 */
async function computeFinancialSnapshot(uid) {
    const settings = await getCashflowSettings(uid);
    // Daily operating cost = family budget + fuel budget (both configurable)
    const dailyOperatingCost = settings.daily_family_budget + settings.daily_fuel_budget;

    // ── 1. Available cash (sum of all account balances) ───────────────────────
    const [
        { data: accounts },
        { data: cats },
        { data: allLiabilities },
        { data: bufferGoals }
    ] = await Promise.all([
        supabase.from('accounts').select('*').eq('user_id', uid),
        supabase.from('categories').select('id, name, type').eq('user_id', uid),
        supabase.from('liabilities').select('*').eq('user_id', uid),
        supabase.from('goals').select('*').eq('user_id', uid).eq('type', 'buffer')
    ]);

    const availableCash = (accounts || []).reduce((s, a) => s + (parseFloat(a.balance) || 0), 0);

    // ── 2. Income — trailing 30-day average from ALL sources (the core fix) ───
    // THE BUG WAS HERE: old code only used SFD + Lalamove categories.
    // Correct: average ALL income transactions over the last 30 days.
    const now = new Date(); now.setHours(0, 0, 0, 0);
    const thirtyAgo = new Date(now); thirtyAgo.setDate(now.getDate() - 30);

    const { data: recentIncomeTx } = await supabase
        .from('transactions').select('amount, category_id, created_at')
        .eq('user_id', uid).eq('type', 'income')
        .gte('created_at', thirtyAgo.toISOString());

    const totalIncomeLast30 = (recentIncomeTx || []).reduce((s, t) => s + (parseFloat(t.amount) || 0), 0);
    /** Average ₱ earned per calendar day over the last 30 days across ALL income sources */
    const avgDailyIncome = totalIncomeLast30 / 30;

    // Income by source (for breakdown chart)
    const incomeBySource = {};
    (recentIncomeTx || []).forEach(t => {
        const cat  = (cats || []).find(c => c.id === t.category_id);
        const name = cat ? cat.name : 'Uncategorized';
        incomeBySource[name] = (incomeBySource[name] || 0) + (parseFloat(t.amount) || 0);
    });

    // Income stability: coefficient of variation of daily totals (past 30 days)
    // Low CV → consistent income → higher stability score.
    const dailyMap = {};
    (recentIncomeTx || []).forEach(t => {
        const day = ymd(t.created_at);
        dailyMap[day] = (dailyMap[day] || 0) + (parseFloat(t.amount) || 0);
    });
    const dailyValues = Object.values(dailyMap);
    let incomeStabilityPct = 50; // default mid
    if (dailyValues.length >= 5) {
        const mean = dailyValues.reduce((s, v) => s + v, 0) / dailyValues.length;
        const variance = dailyValues.reduce((s, v) => s + (v - mean) ** 2, 0) / dailyValues.length;
        const cv = mean > 0 ? Math.sqrt(variance) / mean : 1;
        // cv 0 → 100%; cv ≥ 1.5 → 0%
        incomeStabilityPct = Math.max(0, Math.min(100, Math.round((1 - Math.min(cv / 1.5, 1)) * 100)));
    }

    // ── 3. Expenses — trailing 30-day average ────────────────────────────────
    const { data: recentExpenseTx } = await supabase
        .from('transactions').select('amount, category_id, created_at')
        .eq('user_id', uid).eq('type', 'expense')
        .gte('created_at', thirtyAgo.toISOString());

    const totalExpenseLast30 = (recentExpenseTx || []).reduce((s, t) => s + (parseFloat(t.amount) || 0), 0);
    const avgDailyExpense = totalExpenseLast30 / 30;

    // ── 4. Bills vs Debts — SEPARATED ────────────────────────────────────────
    // Bills  (liability_type = 'bill')  → recurring monthly obligations
    // Debts  (liability_type = 'debt' or null) → personal debts with decreasing balance
    const bills = (allLiabilities || []).filter(l => l.liability_type === 'bill');
    const debts = (allLiabilities || []).filter(l => l.liability_type !== 'bill');

    // Upcoming bills: those whose due_day falls within the next 30 days
    const billsEnriched = bills.map(b => {
        const nextDue     = b.due_day ? getNextDueDate(parseInt(b.due_day), now) : null;
        const daysUntilDue = nextDue ? Math.round((nextDue - now) / 86400000) : null;
        const inWindow     = daysUntilDue !== null ? (daysUntilDue >= 0 && daysUntilDue <= 30) : true;
        return Object.assign({}, b, { nextDueDate: nextDue ? ymd(nextDue) : null, daysUntilDue, inWindow });
    }).sort((a, b) => (a.daysUntilDue ?? 999) - (b.daysUntilDue ?? 999));

    const upcomingBillsTotal = billsEnriched
        .filter(b => b.inWindow)
        .reduce((s, b) => s + (parseFloat(b.amount) || 0), 0);

    const remainingDebt = debts.reduce((s, d) => s + (parseFloat(d.amount) || 0), 0);

    // ── 5. Three-level buffer ─────────────────────────────────────────────────
    const currentBuffer         = (bufferGoals || []).reduce((s, g) => s + (parseFloat(g.current_amount) || 0), 0);
    const emergencyBufferTarget = settings.emergency_buffer_target;
    const operatingBufferTarget = dailyOperatingCost * settings.operating_buffer_days;
    const targetBufferAmount    = settings.target_buffer;

    // Emergency buffer is funded by available cash (first-line defense)
    const emergencyFunded   = Math.min(availableCash, emergencyBufferTarget);
    const emergencyProgress = Math.round(Math.min(100, (emergencyFunded / Math.max(emergencyBufferTarget, 1)) * 100));

    const operatingProgress = Math.round(Math.min(100, (currentBuffer / Math.max(operatingBufferTarget, 1)) * 100));
    const targetProgress    = Math.round(Math.min(100, (currentBuffer / Math.max(targetBufferAmount,    1)) * 100));

    // ── 6. Derived KPIs ───────────────────────────────────────────────────────
    /** How many days the current cash covers at the daily operating cost without earning anything */
    const daysCovered = dailyOperatingCost > 0 ? availableCash / dailyOperatingCost : 0;

    /** Net change in cash per day if current income/expense averages hold */
    const dailyNetFlow = avgDailyIncome - dailyOperatingCost;

    /** avgDailyIncome − dailyOperatingCost: what's left per day to save/pay debts */
    const dailySavingsCapacity = dailyNetFlow;
    const savingsCapacityRating =
        dailySavingsCapacity >= 700 ? 'excellent' :
        dailySavingsCapacity >= 300 ? 'good'      : 'poor';

    // ── 7. Cash Flow Gap (redefined per spec) ────────────────────────────────
    // = Target Buffer + Upcoming Bills + Remaining Debts − Available Cash
    // Negative result → Financially Safe (never show negative to user)
    const rawGap      = targetBufferAmount + upcomingBillsTotal + remainingDebt - availableCash;
    const cashFlowGap = rawGap;
    const isFinanciallySafe = rawGap <= 0;

    // ── 8. Payroll ────────────────────────────────────────────────────────────
    const nextPayroll      = getNextPayroll(settings.payroll_days, now);
    const daysUntilPayroll = nextPayroll ? Math.round((nextPayroll - now) / 86400000) : null;

    // Daily target = Cash Flow Gap ÷ remaining days until next payout
    const dailyTarget = (daysUntilPayroll && daysUntilPayroll > 0 && rawGap > 0)
        ? rawGap / daysUntilPayroll
        : 0;

    // ── 9. Forecast ───────────────────────────────────────────────────────────
    // Project balance forward using trailing average net flow (income − operating cost).
    // This is cash-flow based, NOT payout-based — income continues every day.
    const projectedCashIn7Days = availableCash + dailyNetFlow * 7;

    const projectedCashOnNextPayday = daysUntilPayroll !== null
        ? availableCash + dailyNetFlow * daysUntilPayroll
        : null;

    // On payday the expected payroll credit arrives as well
    const projectedCashOnNextPaydayWithPayroll = projectedCashOnNextPayday !== null
        ? projectedCashOnNextPayday + settings.expected_payroll
        : null;

    // Days until cash runs out (only if net flow is negative)
    let estimatedRunOutDate = null;
    if (dailyNetFlow < 0 && availableCash > 0) {
        const days = Math.floor(availableCash / (-dailyNetFlow));
        const d = new Date(now); d.setDate(d.getDate() + days);
        estimatedRunOutDate = ymd(d);
    }

    // Estimated debt-free date (savings capacity applied to remaining debt)
    let estimatedDebtFreeDate = null;
    if (remainingDebt > 0 && dailySavingsCapacity > 0) {
        const days = Math.ceil(remainingDebt / dailySavingsCapacity);
        const d = new Date(now); d.setDate(d.getDate() + days);
        estimatedDebtFreeDate = ymd(d);
    }

    // Estimated date to reach target buffer
    let estimatedBufferDate = null;
    const bufferDeficit = Math.max(0, targetBufferAmount - currentBuffer);
    if (bufferDeficit > 0 && dailySavingsCapacity > 0) {
        const days = Math.ceil(bufferDeficit / dailySavingsCapacity);
        const d = new Date(now); d.setDate(d.getDate() + days);
        estimatedBufferDate = ymd(d);
    }

    // ── 10. Month-to-date totals (for cards that show MTD) ───────────────────
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const { data: monthTx } = await supabase
        .from('transactions').select('type, amount')
        .eq('user_id', uid).gte('created_at', monthStart.toISOString());

    let monthlyIncome = 0, monthlyExpense = 0;
    (monthTx || []).forEach(t => {
        if (t.type === 'income') monthlyIncome += parseFloat(t.amount) || 0;
        else                     monthlyExpense += parseFloat(t.amount) || 0;
    });
    const netCashFlow = monthlyIncome - monthlyExpense;

    // ── 11. Financial Health Score ────────────────────────────────────────────
    const healthScore = computeHealthScore({
        availableCash, remainingDebt, avgDailyIncome, dailyOperatingCost,
        emergencyBufferTarget, operatingBufferTarget,
        currentBuffer, upcomingBillsTotal, dailySavingsCapacity, incomeStabilityPct
    });

    const healthMessages = {
        green:  'Cash flow is healthy. Keep building your buffer.',
        yellow: 'Monitor your spending. Savings capacity needs attention.',
        red:    'Cash flow risk detected. Focus on reducing expenses or increasing income.',
        blue:   'Good progress. Stay consistent and build toward your target buffer.'
    };

    return {
        // ── Core ──
        availableCash, dailyOperatingCost,
        daysCovered, dailyNetFlow,
        avgDailyIncome, avgDailyExpense,
        dailySavingsCapacity, savingsCapacityRating,
        totalIncomeLast30, totalExpenseLast30,
        incomeBySource, incomeStabilityPct,

        // ── Monthly ──
        monthlyIncome, monthlyExpense, netCashFlow,

        // ── Three-level buffer ──
        currentBuffer,
        emergencyBuffer: {
            target: emergencyBufferTarget,
            current: emergencyFunded,
            remaining: Math.max(0, emergencyBufferTarget - emergencyFunded),
            progress: emergencyProgress,
            isFunded: availableCash >= emergencyBufferTarget
        },
        operatingBuffer: {
            target: Math.round(operatingBufferTarget),
            current: currentBuffer,
            remaining: Math.max(0, operatingBufferTarget - currentBuffer),
            progress: operatingProgress,
            isFunded: currentBuffer >= operatingBufferTarget
        },
        targetBuffer: {
            target: targetBufferAmount,
            current: currentBuffer,
            remaining: Math.max(0, targetBufferAmount - currentBuffer),
            progress: targetProgress,
            isFunded: currentBuffer >= targetBufferAmount
        },

        // ── Bills vs Debts (Phase 2) ──
        bills: billsEnriched,
        upcomingBillsTotal,
        debts,
        remainingDebt,

        // ── Cash Flow Gap ──
        cashFlowGap,
        isFinanciallySafe,
        dailyTarget,

        // ── Payroll ──
        nextPayrollDate: nextPayroll ? ymd(nextPayroll) : null,
        daysUntilPayroll,
        expectedPayroll: settings.expected_payroll,

        // ── Forecast (Phase 4) ──
        forecast: {
            projectedCashIn7Days,
            projectedCashOnNextPayday,
            projectedCashOnNextPaydayWithPayroll,
            estimatedDebtFreeDate,
            estimatedBufferDate,
            estimatedRunOutDate,
            dailyNetFlow
        },

        // ── Health Score (Phase 4) ──
        healthScore,
        health: healthScore.color === 'blue' ? 'green' : healthScore.color,
        healthMessage: healthMessages[healthScore.color] || healthMessages.yellow,

        settings
    };
}

// ── GET /api/engine/snapshot — single source of truth for all KPIs ────────────
app.get('/api/engine/snapshot', requireAuth, async (req, res) => {
    try {
        const snapshot = await computeFinancialSnapshot(req.user.id);
        res.json(snapshot);
    } catch (e) {
        console.error('Engine snapshot error:', e);
        res.status(500).json({ error: e.message });
    }
});

// ── BILLS CRUD (Phase 2) — recurring monthly obligations ─────────────────────
// Stored in the existing liabilities table with liability_type = 'bill'.
// All existing debt-related endpoints (liabilities, liabilities/summary, /pay)
// continue to work unchanged because they never filter on liability_type.

app.get('/api/bills', requireAuth, async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('liabilities').select('*')
            .eq('user_id', req.user.id)
            .eq('liability_type', 'bill')
            .order('due_day', { ascending: true, nullsFirst: false });
        if (error) throw error;
        const now = new Date(); now.setHours(0, 0, 0, 0);
        const enriched = (data || []).map(b => {
            const nextDue      = b.due_day ? getNextDueDate(parseInt(b.due_day), now) : null;
            const daysUntilDue = nextDue ? Math.round((nextDue - now) / 86400000) : null;
            return Object.assign({}, b, { nextDueDate: nextDue ? ymd(nextDue) : null, daysUntilDue });
        });
        res.json(enriched);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/bills', requireAuth, async (req, res) => {
    try {
        const { name, amount, due_day } = req.body;
        if (!name?.trim()) return res.status(400).json({ error: 'name is required' });
        if (isNaN(parseFloat(amount)) || parseFloat(amount) <= 0) return res.status(400).json({ error: 'amount must be a positive number' });

        const payload = {
            name: name.trim(), amount: parseFloat(amount),
            due_day:         due_day ? parseInt(due_day, 10) : null,
            liability_type: 'bill',
            original_amount: parseFloat(amount),
            user_id: req.user.id
        };
        const { data, error } = await supabase.from('liabilities').insert([payload]).select();
        if (error) throw error;
        res.status(201).json(data[0]);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/bills/:id', requireAuth, async (req, res) => {
    try {
        const { name, amount, due_day } = req.body;
        const updates = {};
        if (name    !== undefined) { if (!name.trim()) return res.status(400).json({ error: 'name is required' }); updates.name = name.trim(); }
        if (amount  !== undefined) { if (isNaN(parseFloat(amount)) || parseFloat(amount) <= 0) return res.status(400).json({ error: 'invalid amount' }); updates.amount = parseFloat(amount); updates.original_amount = parseFloat(amount); }
        if (due_day !== undefined) updates.due_day = due_day !== '' ? parseInt(due_day, 10) : null;

        const { data, error } = await supabase.from('liabilities')
            .update(updates).eq('id', req.params.id).eq('user_id', req.user.id).eq('liability_type', 'bill').select();
        if (error) throw error;
        if (!data?.length) return res.status(404).json({ error: 'Bill not found' });
        res.json(data[0]);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/bills/:id reuses the existing DELETE /api/liabilities/:id endpoint —
// no separate route needed since the check is on id + user_id.

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Finance Tracker running on http://localhost:${PORT}`));

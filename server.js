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
        const { account_id, type, amount, description, category_id } = req.body;

        if (!account_id || !type || !amount) return res.status(400).json({ error: 'Missing required fields: account_id, type, amount' });
        if (!['income', 'expense'].includes(type)) return res.status(400).json({ error: 'type must be "income" or "expense"' });
        if (isNaN(parseFloat(amount)) || parseFloat(amount) <= 0) return res.status(400).json({ error: 'amount must be a positive number' });

        const payload = { account_id, type, amount: parseFloat(amount), description, user_id: uid };
        if (category_id) payload.category_id = category_id;

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
        const { account_id, type, amount, description, category_id } = req.body;

        if (!account_id || !type || !amount) return res.status(400).json({ error: 'Missing required fields' });
        if (!['income', 'expense'].includes(type)) return res.status(400).json({ error: 'Invalid type' });
        if (isNaN(parseFloat(amount)) || parseFloat(amount) <= 0) return res.status(400).json({ error: 'Invalid amount' });

        const updates = { account_id, type, amount: parseFloat(amount), description };
        if (category_id !== undefined) updates.category_id = category_id || null;

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
        const { name, amount, due_date } = req.body;
        if (!name?.trim()) return res.status(400).json({ error: 'name is required' });
        if (isNaN(parseFloat(amount)) || parseFloat(amount) <= 0) return res.status(400).json({ error: 'amount must be a positive number' });

        const payload = { name: name.trim(), amount: parseFloat(amount), user_id: uid };
        if (due_date) payload.due_date = due_date;

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
        res.json(data || { daily_goal: 0 });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/settings', requireAuth, async (req, res) => {
    try {
        const uid   = req.user.id;
        const daily_goal = parseFloat(req.body.daily_goal) || 0;
        if (daily_goal < 0) return res.status(400).json({ error: 'daily_goal must be 0 or positive' });

        const { data, error } = await supabase
            .from('user_settings')
            .upsert({ user_id: uid, daily_goal, updated_at: new Date().toISOString() },
                    { onConflict: 'user_id' })
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Finance Tracker running on http://localhost:${PORT}`));

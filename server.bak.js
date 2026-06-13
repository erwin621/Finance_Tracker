require('dotenv').config();
const express = require('express');
const path = require('path');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json());

// Initialize Supabase Client
// Note: We use the SERVICE_KEY here to bypass RLS for server-side operations. 
// In production, ensure user authentication middleware is implemented.
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

// ==========================================
// ROUTES
// ==========================================

/**
 * GET /api/dashboard
 * Fetches total balance, income/expense summaries, accounts, and recent transactions.
 */
app.get('/api/dashboard', async (req, res) => {
    try {
        // In a real app, you would extract the user_id from an auth token
        // const userId = req.user.id; 

        // 1. Fetch Accounts
        const { data: accounts, error: accountsError } = await supabase
            .from('accounts')
            .select('id, name, balance');
            // .eq('user_id', userId); 

        if (accountsError) throw accountsError;

        // 2. Fetch Recent Transactions (Limit to 10)
        const { data: transactions, error: txError } = await supabase
            .from('transactions')
            .select(`
                id, type, amount, category, description, created_at,
                accounts ( name )
            `)
            // .eq('user_id', userId)
            .order('created_at', { ascending: false })
            .limit(10);

        if (txError) throw txError;

        // 3. Calculate Summaries
        let totalBalance = 0;
        accounts.forEach(acc => totalBalance += parseFloat(acc.balance));

        let totalIncome = 0;
        let totalExpenses = 0;

        // Fetch all transactions for accurate summary calculation
        const { data: allTx } = await supabase
            .from('transactions')
            .select('type, amount');

        allTx.forEach(tx => {
            if (tx.type === 'income') totalIncome += parseFloat(tx.amount);
            if (tx.type === 'expense') totalExpenses += parseFloat(tx.amount);
        });

        const savingsRate = totalIncome > 0 
            ? Math.round(((totalIncome - totalExpenses) / totalIncome) * 100) 
            : 0;

        // Send consolidated payload
        res.json({
            summary: {
                totalBalance,
                totalIncome,
                totalExpenses,
                savingsRate
            },
            accounts,
            recentTransactions: transactions
        });

    } catch (error) {
        console.error('Dashboard Error:', error);
        res.status(500).json({ error: 'Failed to load dashboard data' });
    }
});

/**
 * POST /api/transactions
 * Creates a new transaction and automatically updates the account balance via SQL trigger.
 */
app.post('/api/transactions', async (req, res) => {
    try {
        const { account_id, type, amount, category, description, user_id } = req.body;

        // Basic validation
        if (!account_id || !type || !amount) {
            return res.status(400).json({ error: 'Missing required fields' });
        }

        // Insert transaction into Supabase
        const { data, error } = await supabase
            .from('transactions')
            .insert([{
                account_id,
                type, // 'income' or 'expense'
                amount,
                category,
                description,
                user_id // Ensure this is passed or decoded from auth token
            }])
            .select();

        if (error) throw error;

        res.status(201).json({ 
            message: 'Transaction added successfully', 
            transaction: data[0] 
        });

    } catch (error) {
        console.error('Transaction Error:', error);
        res.status(500).json({ error: 'Failed to add transaction' });
    }
});

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, `public`)));

// ==========================================
// START SERVER
// ==========================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});

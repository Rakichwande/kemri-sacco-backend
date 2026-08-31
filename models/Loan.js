const { query } = require('../config/database');

class Loan {
    // Create a new loan application
    static async create({
        member_id,
        principal,
        interest_rate = 6.0,
        tenure_months = 3
    }) {
        const total_interest = Math.round(principal * (interest_rate / 100) * tenure_months);
        const total_repayment = principal + total_interest;
        const monthly_installment = Math.round(total_repayment / tenure_months);

        const sql = `
            INSERT INTO loans (
                member_id, principal, interest_rate, tenure_months,
                total_interest, total_repayment, monthly_installment,
                outstanding_balance, status, applied_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', NOW())
            RETURNING *
        `;
        const values = [
            member_id, principal, interest_rate, tenure_months,
            total_interest, total_repayment, monthly_installment,
            total_repayment
        ];

        const result = await query(sql, values);
        return result.rows[0];
    }

    // Approve a loan (sets it active, updates member's outstanding balance)
    static async approve(loanId) {
        // Start transaction
        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            // 1. Get loan details
            const loanRes = await client.query(
                'SELECT member_id, total_repayment FROM loans WHERE id = $1',
                [loanId]
            );
            if (loanRes.rows.length === 0) throw new Error('Loan not found');
            const loan = loanRes.rows[0];

            // 2. Update loan status
            await client.query(
                `UPDATE loans 
                 SET status = 'active', approved_at = NOW(), 
                     next_payment_due = NOW() + INTERVAL '1 month'
                 WHERE id = $1`,
                [loanId]
            );

            // 3. Add to member's outstanding balance
            await client.query(
                `UPDATE members 
                 SET total_outstanding_balance = total_outstanding_balance + $1
                 WHERE id = $2`,
                [loan.total_repayment, loan.member_id]
            );

            await client.query('COMMIT');
            return { success: true };
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }
    }

    // Record a repayment (partial or full)
    static async recordRepayment(loanId, amount) {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            // Get current loan status
            const loanRes = await client.query(
                'SELECT member_id, outstanding_balance, status, total_repayment FROM loans WHERE id = $1 FOR UPDATE',
                [loanId]
            );
            if (loanRes.rows.length === 0) throw new Error('Loan not found');
            const loan = loanRes.rows[0];
            if (loan.status !== 'active') throw new Error('Loan is not active');

            const newBalance = loan.outstanding_balance - amount;
            const newAmountPaid = loan.total_repayment - newBalance;

            // Update loan
            await client.query(
                `UPDATE loans 
                 SET outstanding_balance = $1, amount_paid = $2,
                     status = CASE WHEN $1 <= 0 THEN 'repaid' ELSE status END,
                     repaid_at = CASE WHEN $1 <= 0 THEN NOW() ELSE repaid_at END
                 WHERE id = $3`,
                [newBalance, newAmountPaid, loanId]
            );

            // Update member's total outstanding and successful repayments
            const memberUpdateQuery = newBalance <= 0 ? `
                UPDATE members 
                SET total_outstanding_balance = total_outstanding_balance - $1,
                    successful_repayments = successful_repayments + 1
                WHERE id = $2
            ` : `
                UPDATE members 
                SET total_outstanding_balance = total_outstanding_balance - $1
                WHERE id = $2
            `;
            await client.query(memberUpdateQuery, [amount, loan.member_id]);

            await client.query('COMMIT');
            return { 
                success: true, 
                fully_repaid: newBalance <= 0,
                new_balance: newBalance 
            };
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }
    }

    // Get active loan for a member
    static async getActiveLoan(memberId) {
        const sql = `
            SELECT * FROM loans 
            WHERE member_id = $1 AND status IN ('pending', 'active')
            ORDER BY applied_at DESC LIMIT 1
        `;
        const result = await query(sql, [memberId]);
        return result.rows[0] || null;
    }

    // Get loan history for a member
    static async getHistory(memberId, limit = 10) {
        const sql = `
            SELECT * FROM loans 
            WHERE member_id = $1 
            ORDER BY applied_at DESC 
            LIMIT $2
        `;
        const result = await query(sql, [memberId, limit]);
        return result.rows;
    }
}

module.exports = Loan;

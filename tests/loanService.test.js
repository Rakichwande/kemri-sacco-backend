const LoanService = require('../services/loanService');
const db = require('../config/database');
const Member = require('../models/Member');

// Mock the database module
jest.mock('../config/database', () => ({
  query: jest.fn(),
}));

// Mock the Member model
jest.mock('../models/Member', () => ({
  findById: jest.fn(),
}));

describe('LoanService - Core Business Rules', () => {

  beforeEach(() => {
    jest.clearAllMocks(); // Clear mock history before each test
  });

  it('should BLOCK a member with a 0 credit limit', async () => {
    // Setup: Member has 0 limit
    Member.findById.mockResolvedValue({ id: 1, credit_limit: 0 });

    const result = await LoanService.canApply(1);
    
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('currently not eligible');
  });

  it('should BLOCK a member who already has an active loan (Strict Block)', async () => {
    // Setup: Member has a 10k limit, but the DB returns an active loan
    Member.findById.mockResolvedValue({ id: 1, credit_limit: 10000 });
    
    db.query.mockResolvedValueOnce({ rows: [{ id: 99 }] }); // Active loan found

    const result = await LoanService.canApply(1);
    
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('already have an active or pending loan');
  });

  it('should ALLOW a member with no active loans and a valid limit', async () => {
    // Setup: Member has a 5k limit, no active loans
    Member.findById.mockResolvedValue({ id: 1, credit_limit: 5000 });
    
    db.query.mockResolvedValueOnce({ rows: [] }); // No active loans

    const result = await LoanService.canApply(1);
    
    expect(result.allowed).toBe(true);
    expect(result.creditLimit).toBe(5000);
  });

  it('should BLOCK an Admin from approving a loan that exceeds the limit', async () => {
    // Setup: Member has 5k limit. Pending loan is 10k.
    db.query.mockResolvedValueOnce({ 
      rows: [{ id: 100, member_id: 1, principal: 10000, status: 'pending' }] 
    }); // Fetch pending loan
    
    Member.findById.mockResolvedValue({ id: 1, credit_limit: 5000 });
    
    db.query.mockResolvedValueOnce({ rows: [] }); // No OTHER active loans

    const result = await LoanService.approveLoan(100, 'Admin approval');
    
    expect(result.success).toBe(false);
    expect(result.message).toContain('ACTION BLOCKED');
  });

});
// Central definition of roles, what each is allowed to do, and who is
// allowed to assign which roles to others.

const ROLES = {
  SUPER_ADMIN: 'admin',             // Full system administration and configuration
  SACCO_ADMIN: 'sacco_admin',       // General operations and member management
  FINANCE_OFFICER: 'finance_officer', // Financial transactions, payments and reports
  LOANS_OFFICER: 'loans_officer',   // Loan applications and loan-related records
  MEMBER_SUPPORT: 'member_support', // Member information and support functions
  AUDITOR: 'auditor',               // Read-only access to relevant records and audit info
  STAFF_LEGACY: 'staff',            // Pre-existing generic staff role, kept working as-is
};

const PERMISSIONS = {
  [ROLES.SUPER_ADMIN]: [
    'system:configure',
    'staff:manage',
    // 2026-11-05: CEO has exclusive rights to edit members, limits, board status, and deletion.
    'members:read', 'members:write', 'members:set_board_status', 'members:delete', 'members:edit_limit',
    'loans:read', 'loans:approve', 'loans:disburse',
    'payments:read', 'payments:write',
    'withdrawals:read', 'withdrawals:write',
    'reports:read',
    'audit:read',
  ],
  [ROLES.SACCO_ADMIN]: [
    'staff:manage',
    // 2026-11-05: Stripped of members:write, members:set_board_status, and members:delete. 
    // They can only view members now. Only the CEO can edit them.
    'members:read', 
    'loans:read', 'loans:approve', 'loans:disburse',
    'payments:read',
    'withdrawals:read', 'withdrawals:write',
    'reports:read',
    'audit:read',
  ],
  [ROLES.FINANCE_OFFICER]: [
    'members:read',
    'payments:read', 'payments:write',
    'withdrawals:read', 'withdrawals:write',
    'reports:read',
    'loans:read', 
    'staff:manage',
    'system:configure',
  ],
  [ROLES.LOANS_OFFICER]: [
    'members:read',
    'loans:read', 'loans:approve', 'loans:disburse',
    'withdrawals:read',
  ],
  [ROLES.MEMBER_SUPPORT]: [
    'members:read', // 2026-11-05: Stripped of members:write. Read-only.
    'withdrawals:read',
  ],
  [ROLES.AUDITOR]: [
    'members:read',
    'loans:read',
    'payments:read',
    'withdrawals:read',
    'reports:read',
    'audit:read',
  ],
  [ROLES.STAFF_LEGACY]: [
    'members:read',
    'loans:read',
    'payments:read',
    'withdrawals:read',
  ],
};

const ASSIGNABLE_ROLES = {
  [ROLES.SUPER_ADMIN]: [
    ROLES.SUPER_ADMIN, ROLES.SACCO_ADMIN,
    ROLES.FINANCE_OFFICER, ROLES.LOANS_OFFICER,
  ],
  [ROLES.SACCO_ADMIN]: [
    ROLES.FINANCE_OFFICER, ROLES.LOANS_OFFICER,
  ],
};

function roleHasPermission(role, permission) {
  return (PERMISSIONS[role] || []).includes(permission);
}

function canAssignRole(assignerRole, targetRole) {
  return (ASSIGNABLE_ROLES[assignerRole] || []).includes(targetRole);
}

module.exports = { ROLES, PERMISSIONS, ASSIGNABLE_ROLES, roleHasPermission, canAssignRole };
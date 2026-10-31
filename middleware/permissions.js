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
    'members:read', 'members:write', 'members:set_board_status', 'members:delete',
    'members:edit_limit', // <--- 2026-10-31: ADDED FOR CEO ONLY
    'loans:read', 'loans:approve', 'loans:disburse',
    'payments:read', 'payments:write',
    'withdrawals:read', 'withdrawals:write',
    'reports:read',
    'audit:read',
  ],
  [ROLES.SACCO_ADMIN]: [
    'staff:manage',
    'members:read', 'members:write', 'members:set_board_status', 'members:delete',
    // 'members:edit_limit', // <--- NOT ALLOWED FOR SACCO ADMIN
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
    'members:read', 'members:write',
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
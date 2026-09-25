// Central definition of roles, what each is allowed to do, and who is
// allowed to assign which roles to others. Adding a new permission check
// anywhere in the app should mean adding one entry here, not writing a new
// `if (req.user.role === '...')` in a route file.
//
// Role values stored in admins.role (VARCHAR(20), unconstrained - see
// models/Admin.js). IMPORTANT: the top role is stored as 'admin', not
// 'super_admin' - existing accounts and the existing requireAdmin
// middleware (role === 'admin') both already use that exact string, so
// reusing it means every current admin account is automatically a Super
// Administrator under this model with no migration needed. 'staff' is kept
// as a legacy role too, so existing staff accounts keep working with a
// sensible (read-mostly) permission set until individually migrated to one
// of the more specific operational roles below.
const ROLES = {
  SUPER_ADMIN: 'admin',             // Full system administration and configuration
  SACCO_ADMIN: 'sacco_admin',       // General operations and member management
  FINANCE_OFFICER: 'finance_officer', // Financial transactions, payments and reports
  LOANS_OFFICER: 'loans_officer',   // Loan applications and loan-related records
  MEMBER_SUPPORT: 'member_support', // Member information and support functions
  AUDITOR: 'auditor',               // Read-only access to relevant records and audit info
  STAFF_LEGACY: 'staff',            // Pre-existing generic staff role, kept working as-is
};

// Permission naming: <resource>:<action>. Reads and writes are the bulk of
// it, but two member permissions are deliberately NOT part of the generic
// members:write grant, because they carry more consequence than "edit a
// profile field" and must be grantable independently:
//
//   members:set_board_status — flips a member into the board/staff category,
//     which auto-approves their future loan applications under SACCO policy
//     (25 Sept 2026). A data-entry role with members:write should not be
//     able to grant that.
//
//   members:delete — permanently removes a member record (only when they
//     have no transaction history; see the delete spec). Destructive and
//     irreversible, so again kept off the general write grant.
//
// Both are granted to Super Administrator and SACCO Administrator only.
const PERMISSIONS = {
  [ROLES.SUPER_ADMIN]: [
    'system:configure',
    'staff:manage',
    'members:read', 'members:write', 'members:set_board_status', 'members:delete',
    'loans:read', 'loans:approve', 'loans:disburse',
    'payments:read', 'payments:write',
    'withdrawals:read', 'withdrawals:write',
    'reports:read',
    'audit:read',
  ],
  [ROLES.SACCO_ADMIN]: [
    'staff:manage',
    'members:read', 'members:write', 'members:set_board_status', 'members:delete',
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
    // Explicitly read-only - no :write, :approve, or :disburse anywhere.
    'members:read',
    'loans:read',
    'payments:read',
    'withdrawals:read',
    'reports:read',
    'audit:read',
  ],
  [ROLES.STAFF_LEGACY]: [
    // Matches the original README description: can view member and
    // transaction records, cannot approve loans or manage staff accounts.
    'members:read',
    'loans:read',
    'payments:read',
    'withdrawals:read',
  ],
};

// Who can assign which roles to OTHER accounts, when creating or editing
// staff. Without this, anyone with staff:manage could hand out the top
// role to anyone, including themselves later - a privilege-escalation
// path. A SACCO Administrator can staff up the operational roles but
// cannot create or promote someone to Super Administrator or SACCO
// Administrator; only an existing Super Administrator can do that.
const ASSIGNABLE_ROLES = {
  [ROLES.SUPER_ADMIN]: [
    ROLES.SUPER_ADMIN, ROLES.SACCO_ADMIN, ROLES.FINANCE_OFFICER,
    ROLES.LOANS_OFFICER, ROLES.MEMBER_SUPPORT, ROLES.AUDITOR, ROLES.STAFF_LEGACY,
  ],
  [ROLES.SACCO_ADMIN]: [
    ROLES.FINANCE_OFFICER, ROLES.LOANS_OFFICER, ROLES.MEMBER_SUPPORT, ROLES.AUDITOR,
  ],
};

function roleHasPermission(role, permission) {
  return (PERMISSIONS[role] || []).includes(permission);
}

// Can `assignerRole` grant `targetRole` to some other account?
function canAssignRole(assignerRole, targetRole) {
  return (ASSIGNABLE_ROLES[assignerRole] || []).includes(targetRole);
}

module.exports = { ROLES, PERMISSIONS, ASSIGNABLE_ROLES, roleHasPermission, canAssignRole };
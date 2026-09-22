import React, { useState, useEffect } from 'react';
import AdminLayout from '../components/AdminLayout';
import LoadingState, { friendlyErrorMessage } from '../components/LoadingState';
import { useAuth } from '../context/AuthContext';

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:3000';

// Keep this list in one place so the invite modal and the per-row role
// select can't drift out of sync with each other. Values must match
// ROLES in middleware/permissions.js exactly - note Super Administrator
// is stored as 'admin', not 'super_admin'.
const ROLES = [
  { value: 'staff', label: 'Staff (view-only)' },
  { value: 'admin', label: 'Super Administrator' },
  { value: 'sacco_admin', label: 'SACCO Administrator' },
  { value: 'finance_officer', label: 'Finance Officer' },
  { value: 'loans_officer', label: 'Loans Officer' },
  { value: 'member_support', label: 'Member Support' },
  { value: 'auditor', label: 'Auditor' },
];

// Mirrors ASSIGNABLE_ROLES in middleware/permissions.js, so the dropdown
// only ever offers roles the current user is actually allowed to grant.
// This is UI convenience, not the security boundary - the server still
// enforces canAssignRole() on every request regardless of what this
// returns; it just means a SACCO Administrator never sees an option that
// would 403 if picked.
const ASSIGNABLE_ROLES = {
  admin: ['admin', 'sacco_admin', 'finance_officer', 'loans_officer', 'member_support', 'auditor', 'staff'],
  sacco_admin: ['finance_officer', 'loans_officer', 'member_support', 'auditor'],
};

function assignableRolesFor(assignerRole) {
  const allowedValues = ASSIGNABLE_ROLES[assignerRole] || [];
  return ROLES.filter((r) => allowedValues.includes(r.value));
}

function InviteModal({ onClose, onSent, assignerRole }) {
  const options = assignableRolesFor(assignerRole);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState(options[0]?.value || 'staff');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null); // { inviteLink, emailSent, emailReason }

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const token = localStorage.getItem('token');
      const res = await fetch(`${API_BASE}/api/auth/invites`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ email, role }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to send invite');
      }
      const data = await res.json();
      setResult(data);
      onSent();
    } catch (err) {
      setError(friendlyErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  const copyLink = () => {
    navigator.clipboard.writeText(result.inviteLink);
  };

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(31,36,33,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: '#fff', borderRadius: 6, width: 420, maxWidth: '90vw', padding: 24 }}>
        {!result ? (
          <>
            <div style={{ fontFamily: 'var(--font-display)', fontSize: '1.3rem', fontWeight: 600, color: 'var(--color-forest-deep)', marginBottom: 4 }}>
              Invite Staff Member
            </div>
            <div style={{ fontSize: '0.85rem', color: 'rgba(31,36,33,0.6)', marginBottom: 16 }}>
              Send an invitation email. The recipient will be able to sign in to this admin console.
            </div>
            {error && <div className="error-banner" style={{ marginBottom: 12 }}>{error}</div>}
            <form onSubmit={handleSubmit}>
              <div style={{ marginBottom: 14 }}>
                <div style={{ fontSize: '0.72rem', textTransform: 'uppercase', color: 'rgba(31,36,33,0.5)', marginBottom: 4 }}>Email address</div>
                <input
                  type="email" required value={email} onChange={(e) => setEmail(e.target.value)}
                  placeholder="colleague@kemri.go.ke"
                  style={{ width: '100%', padding: '9px 12px', border: '1px solid var(--color-line)', borderRadius: 4, fontSize: '0.9rem' }}
                />
              </div>
              <div style={{ marginBottom: 18 }}>
                <div style={{ fontSize: '0.72rem', textTransform: 'uppercase', color: 'rgba(31,36,33,0.5)', marginBottom: 4 }}>Role</div>
                <select
                  value={role} onChange={(e) => setRole(e.target.value)}
                  style={{ width: '100%', padding: '9px 12px', border: '1px solid var(--color-line)', borderRadius: 4, fontSize: '0.9rem', background: '#fff' }}
                >
                  {options.map((r) => (
                    <option key={r.value} value={r.value}>{r.label}</option>
                  ))}
                </select>
              </div>
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <button type="button" onClick={onClose} style={{ padding: '9px 18px', border: '1px solid var(--color-line)', borderRadius: 4, background: '#fff', cursor: 'pointer' }}>
                  Cancel
                </button>
                <button type="submit" disabled={submitting} className="admin-btn admin-btn--approve">
                  {submitting ? 'Sending…' : 'Send Invitation'}
                </button>
              </div>
            </form>
          </>
        ) : (
          <>
            <div style={{ fontFamily: 'var(--font-display)', fontSize: '1.3rem', fontWeight: 600, color: 'var(--color-forest-deep)', marginBottom: 12 }}>
              Invite Created
            </div>
            {result.emailSent ? (
              <div style={{ padding: '10px 14px', background: 'var(--color-sage)', color: 'var(--color-forest-deep)', borderRadius: 4, fontSize: '0.88rem', marginBottom: 16 }}>
                Invitation email sent to {email}.
              </div>
            ) : (
              <div style={{ padding: '10px 14px', background: 'var(--color-gold-soft)', color: '#7a5a10', borderRadius: 4, fontSize: '0.85rem', marginBottom: 16 }}>
                Email couldn't be sent ({result.emailReason || 'not configured yet'}). Share this link with {email} directly instead:
              </div>
            )}
            <div style={{ display: 'flex', gap: 8, marginBottom: 18 }}>
              <input readOnly value={result.inviteLink} style={{ flex: 1, padding: '8px 10px', border: '1px solid var(--color-line)', borderRadius: 4, fontSize: '0.82rem', fontFamily: 'var(--font-mono)' }} />
              <button onClick={copyLink} style={{ padding: '8px 14px', border: '1px solid var(--color-line)', borderRadius: 4, background: '#fff', cursor: 'pointer', fontSize: '0.85rem' }}>
                Copy
              </button>
            </div>
            <button onClick={onClose} className="admin-btn admin-btn--approve" style={{ width: '100%' }}>Done</button>
          </>
        )}
      </div>
    </div>
  );
}

function StaffManagement() {
  const { user: currentUser } = useAuth();
  const [staff, setStaff] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showInvite, setShowInvite] = useState(false);

  const getToken = () => localStorage.getItem('token');

  const fetchStaff = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/api/auth/users`, {
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${getToken()}` },
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      setStaff(await res.json());
    } catch (err) {
      console.error('Fetch staff error:', err);
      setError(friendlyErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchStaff(); }, []);

  const handleRoleChange = async (id, role) => {
    try {
      const res = await fetch(`${API_BASE}/api/auth/users/${id}/role`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${getToken()}` },
        body: JSON.stringify({ role }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to update role');
      }
      fetchStaff();
    } catch (err) {
      alert('Error: ' + err.message);
      fetchStaff();
    }
  };

  const handleRemove = async (id, name) => {
    if (!window.confirm(`Remove ${name}'s access to this console?`)) return;
    try {
      const res = await fetch(`${API_BASE}/api/auth/users/${id}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${getToken()}` },
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to remove account');
      }
      fetchStaff();
    } catch (err) {
      alert('Error: ' + err.message);
    }
  };

  const assignableOptions = assignableRolesFor(currentUser?.role);

  return (
    <AdminLayout title="Staff & Admin Management" lede="Manage who can access this admin console and their permissions.">
      {error && <div className="error-banner" style={{ marginBottom: 20 }}>{error}</div>}

      <div style={{
        background: 'var(--color-sage)', border: '1px solid var(--color-line)', borderRadius: 4,
        padding: '12px 16px', marginBottom: 20, fontSize: '0.85rem', color: 'var(--color-forest-deep)',
      }}>
        Each role has a different scope of access — Super Administrator and SACCO Administrator have the
        broadest access, while Finance Officer, Loans Officer, Member Support, and Auditor are scoped to
        their area. Staff accounts are view-only.
      </div>

      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 16 }}>
        <button className="admin-btn admin-btn--approve" onClick={() => setShowInvite(true)}>
          + Invite Staff
        </button>
      </div>

      {loading ? (
        <LoadingState />
      ) : (
        <div className="admin-table-card">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Username</th>
                <th>Phone</th>
                <th>Role</th>
                <th>Added</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {staff.map((s) => {
                // A row's own current role must always be selectable even
                // if the viewer couldn't newly grant it (e.g. a SACCO
                // Administrator viewing another SACCO Administrator's
                // row) - otherwise the <select> silently falls back to
                // whatever option happens to be first in the list.
                const rowOptions = assignableOptions.some((r) => r.value === s.role)
                  ? assignableOptions
                  : [ROLES.find((r) => r.value === s.role), ...assignableOptions].filter(Boolean);

                return (
                  <tr key={s.id}>
                    <td style={{ fontWeight: 500 }}>
                      {s.full_name} {s.id === currentUser?.id && <span style={{ color: 'rgba(31,36,33,0.45)', fontWeight: 400 }}>(you)</span>}
                    </td>
                    <td style={{ color: 'rgba(31,36,33,0.6)' }}>{s.username}</td>
                    <td style={{ color: 'rgba(31,36,33,0.6)' }}>{s.phone || '—'}</td>
                    <td>
                      <select
                        value={s.role}
                        onChange={(e) => handleRoleChange(s.id, e.target.value)}
                        disabled={s.id === currentUser?.id || rowOptions.length === 0}
                        style={{ padding: '5px 8px', border: '1px solid var(--color-line)', borderRadius: 4, fontSize: '0.85rem' }}
                      >
                        {rowOptions.map((r) => (
                          <option key={r.value} value={r.value}>{r.label}</option>
                        ))}
                      </select>
                    </td>
                    <td style={{ color: 'rgba(31,36,33,0.6)' }}>
                      {new Date(s.created_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}
                    </td>
                    <td>
                      {s.id !== currentUser?.id && (
                        <button className="admin-btn admin-btn--reject" onClick={() => handleRemove(s.id, s.full_name)}>
                          Remove
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {showInvite && (
        <InviteModal onClose={() => setShowInvite(false)} onSent={fetchStaff} assignerRole={currentUser?.role} />
      )}
    </AdminLayout>
  );
}

export default StaffManagement;
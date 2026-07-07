// Route guards (spec 019). RequireAuth → /auth/login when anonymous; RequireAdmin → home for non-admins.

import type { ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import { Loading } from '../components/StatusMessage.tsx';
import { useAuth } from './AuthContext.tsx';

export function RequireAuth({ children }: { children: ReactNode }) {
  const { loading, user } = useAuth();
  if (loading) return <Loading className="mt-16 text-center" />;
  return user ? <>{children}</> : <Navigate to="/auth/login" replace />;
}

export function RequireAdmin({ children }: { children: ReactNode }) {
  const { loading, isAdmin } = useAuth();
  if (loading) return <Loading className="mt-16 text-center" />;
  return isAdmin ? <>{children}</> : <Navigate to="/" replace />;
}

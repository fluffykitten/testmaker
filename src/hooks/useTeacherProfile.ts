import { useContext } from 'react';
import { TeacherProfileContext, type TeacherProfileContextValue } from '../contexts/TeacherProfileContext';

export function useTeacherProfile(): TeacherProfileContextValue {
  const ctx = useContext(TeacherProfileContext);
  if (!ctx) {
    throw new Error('useTeacherProfile must be used within a TeacherProfileProvider');
  }
  return ctx;
}

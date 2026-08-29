 'use client';

import type { ReactElement } from 'react';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { readAuthSession } from '../utils/authSession';

/** Điều hướng route cũ theo vai hiện tại để không còn chung một portal cho hai ghế. */
export default function ExecutivePage(): ReactElement {
  const router = useRouter();
  useEffect(() => {
    const role = readAuthSession().userRole;
    router.replace(role === 'executive_chair' ? '/executive/chair' : role === 'executive_member' ? '/executive/member' : '/unauthorized');
  }, [router]);
  return <main className="grid min-h-screen place-items-center"><div className="h-8 w-8 animate-spin rounded-full border-4 border-violet-700 border-t-transparent" /></main>;
}

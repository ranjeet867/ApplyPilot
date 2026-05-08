import React from 'react';
import type { Job } from '../../types';
import { STATUS_LABEL } from '../../shared/utils';

const DOTS: Record<Job['status'], string> = {
  new:     '🔵',
  opened:  '🟡',
  applied: '🟢',
  skipped: '⚪',
  failed:  '🔴',
};

interface Props {
  status: Job['status'];
}

export default function StatusBadge({ status }: Props) {
  return (
    <span className={`status-badge ${status}`}>
      {DOTS[status]} {STATUS_LABEL[status]}
    </span>
  );
}

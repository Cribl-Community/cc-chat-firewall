import type { ReactNode } from 'react';
import { Text } from '@capra/core';

type Props = {
  title: string;
  description?: string;
  actions?: ReactNode;
  tabs?: ReactNode;
};

/** Fixed header at the top of the main content: title, description, actions, and optional tabs. */
export function PageHeader({ title, description, actions, tabs }: Props) {
  return (
    <header className="page-header">
      <div className="page-header-row">
        <div className="page-header-text">
          <Text as="h1" variant="heading-md">
            {title}
          </Text>
          {description && (
            <Text as="p" color="subtle">
              {description}
            </Text>
          )}
        </div>
        {actions && <div className="page-header-actions">{actions}</div>}
      </div>
      {tabs}
    </header>
  );
}

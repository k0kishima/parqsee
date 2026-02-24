import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronRight } from 'lucide-react';

interface BreadcrumbNavProps {
  currentDir: string;
  onNavigate: (path: string) => void;
}

const MAX_VISIBLE_SEGMENTS = 3;

export function BreadcrumbNav({ currentDir, onNavigate }: BreadcrumbNavProps) {
  const { t } = useTranslation();

  const breadcrumbSegments = useMemo(() => {
    if (!currentDir) return [];
    const parts = currentDir.split('/').filter(Boolean);
    const segments: { name: string; path: string }[] = [];
    segments.push({ name: t('fileExplorer.breadcrumb.root'), path: '/' });
    for (let i = 0; i < parts.length; i++) {
      segments.push({
        name: parts[i],
        path: '/' + parts.slice(0, i + 1).join('/'),
      });
    }
    return segments;
  }, [currentDir, t]);

  const visibleBreadcrumbs = useMemo(() => {
    if (breadcrumbSegments.length <= MAX_VISIBLE_SEGMENTS + 1) {
      return { segments: breadcrumbSegments, truncated: false };
    }
    const first = breadcrumbSegments[0];
    const lastSegments = breadcrumbSegments.slice(-MAX_VISIBLE_SEGMENTS);
    return { segments: [first, ...lastSegments], truncated: true };
  }, [breadcrumbSegments]);

  if (!currentDir) return null;

  return (
    <div className="flex items-center mt-1 text-xs overflow-hidden" title={currentDir}>
      {visibleBreadcrumbs.segments.map((segment, index) => {
        const isLast = index === visibleBreadcrumbs.segments.length - 1;
        const showEllipsis = visibleBreadcrumbs.truncated && index === 0;
        return (
          <React.Fragment key={segment.path}>
            <button
              onClick={() => onNavigate(segment.path)}
              className={`truncate max-w-[60px] shrink-0
                ${isLast ? 'text-secondary' : 'text-tertiary hover:text-primary'}`}
              title={segment.path}
            >
              {segment.name}
            </button>
            {showEllipsis && (
              <>
                <ChevronRight className="w-3 h-3 mx-0.5 shrink-0 text-tertiary" />
                <span className="shrink-0 text-tertiary">...</span>
              </>
            )}
            {!isLast && (
              <ChevronRight className="w-3 h-3 mx-0.5 shrink-0 text-tertiary" />
            )}
          </React.Fragment>
        );
      })}
    </div>
  );
}

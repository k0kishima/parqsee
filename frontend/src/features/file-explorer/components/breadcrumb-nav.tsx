import React, { useMemo } from 'react';
import { ChevronRight } from 'lucide-react';
import type { WorkspaceRoot } from '../../workspace/api';
import { ancestorsWithin, getFileName } from '../../../lib/path';

interface BreadcrumbNavProps {
  /** The workspace root `dir` lies in; the trail starts and stops here. */
  root: WorkspaceRoot;
  dir: string;
  onNavigate: (path: string) => void;
}

const MAX_VISIBLE_SEGMENTS = 3;

/**
 * Where the selected file's folder sits within its workspace root. The trail
 * never climbs above the root: under the sandbox nothing above it is
 * readable, and outside it nobody browses from `/`.
 */
export function BreadcrumbNav({ root, dir, onNavigate }: BreadcrumbNavProps) {
  const breadcrumbSegments = useMemo(() => {
    const chain = ancestorsWithin(root.path, dir);
    return chain.map((path, index) => ({ path, name: index === 0 ? root.name : getFileName(path) }));
  }, [root, dir]);

  const visibleBreadcrumbs = useMemo(() => {
    if (breadcrumbSegments.length <= MAX_VISIBLE_SEGMENTS + 1) {
      return { segments: breadcrumbSegments, truncated: false };
    }
    const first = breadcrumbSegments[0];
    const lastSegments = breadcrumbSegments.slice(-MAX_VISIBLE_SEGMENTS);
    return { segments: [first, ...lastSegments], truncated: true };
  }, [breadcrumbSegments]);

  if (breadcrumbSegments.length === 0) return null;

  return (
    <nav aria-label="breadcrumb" className="flex items-center text-xs overflow-hidden" title={dir}>
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
    </nav>
  );
}

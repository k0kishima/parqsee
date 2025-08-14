import React, { useState, useEffect, useRef } from 'react';
import { DataViewer } from './DataViewer';

interface TabContentProps {
  tab: {
    id: string;
    path: string;
    name: string;
  };
  isActive: boolean;
  onClose: () => void;
  savedState?: TabState;
  onStateChange?: (state: TabState) => void;
}

export interface TabState {
  scrollPosition?: number;
  currentPage?: number;
  searchTerm?: string;
  // Add more state as needed
}

export const TabContent: React.FC<TabContentProps> = React.memo(({ 
  tab, 
  isActive, 
  onClose,
  savedState,
  onStateChange
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [hasBeenActive, setHasBeenActive] = useState(false);

  useEffect(() => {
    if (isActive && !hasBeenActive) {
      setHasBeenActive(true);
    }
  }, [isActive, hasBeenActive]);

  // Only render DataViewer if tab is active or has been active before
  // This lazy loads tabs when they're first accessed
  if (!isActive && !hasBeenActive) {
    return <div className="flex-1" />;
  }

  return (
    <div 
      ref={containerRef}
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        display: isActive ? 'block' : 'none',
        // Enable hardware acceleration
        transform: 'translateZ(0)',
        willChange: isActive ? 'auto' : 'contents'
      }}
    >
      <DataViewer 
        filePath={tab.path} 
        onClose={onClose}
      />
    </div>
  );
}, (prevProps, nextProps) => {
  // Custom comparison to prevent unnecessary re-renders
  if (prevProps.isActive !== nextProps.isActive) return false;
  if (prevProps.tab.id !== nextProps.tab.id) return false;
  if (prevProps.tab.path !== nextProps.tab.path) return false;
  return true; // Props are equal, skip re-render
});

TabContent.displayName = 'TabContent';
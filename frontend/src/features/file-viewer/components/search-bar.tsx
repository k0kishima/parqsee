import { useEffect, useRef, useState } from "react";

interface SearchBarProps {
  isOpen: boolean;
  searchTerm: string;
  onSearchSubmit: (value: string) => void;
  onClose: () => void;
  currentMatch: number;
  totalMatches: number;
  onNext: () => void;
  onPrevious: () => void;
  isSearching?: boolean;
  focusTrigger?: number;
  initialValue?: string;
}

export function SearchBar({
  isOpen,
  searchTerm,
  onSearchSubmit,
  onClose,
  currentMatch,
  totalMatches,
  onNext,
  onPrevious,
  isSearching = false,
  focusTrigger = 0,
  initialValue = "",
}: SearchBarProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  // Manage input value internally to prevent parent re-renders
  const [localInputValue, setLocalInputValue] = useState(initialValue);

  useEffect(() => {
    if (isOpen && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isOpen, focusTrigger]);

  // Reset local input when search bar is closed
  useEffect(() => {
    if (!isOpen) {
      setLocalInputValue("");
    }
  }, [isOpen]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      onClose();
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (!searchTerm || searchTerm !== localInputValue) {
        // If no search has been performed yet or input changed, perform search
        onSearchSubmit(localInputValue);
      } else if (e.shiftKey) {
        // Navigate to previous match
        onPrevious();
      } else {
        // Navigate to next match
        onNext();
      }
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      onPrevious();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      onNext();
    } else if ((e.metaKey || e.ctrlKey) && e.key === "g") {
      e.preventDefault();
      if (e.shiftKey) {
        onPrevious();
      } else {
        onNext();
      }
    }
  };

  const handleClear = () => {
    setLocalInputValue("");
    onSearchSubmit(""); // Clear search results
  };

  if (!isOpen) return null;

  return (
    <div className="absolute top-0 right-0 m-4 z-50 bg-white rounded-lg shadow-lg border border-slate-200 p-3 flex items-center space-x-3">
      <div className="flex items-center flex-1 relative">
        <svg
          className="absolute left-3 w-4 h-4 text-slate-400"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
          />
        </svg>
        <input
          ref={inputRef}
          type="text"
          value={localInputValue}
          onChange={(e) => setLocalInputValue(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Type and press Enter to search..."
          className="pl-10 pr-3 py-2 w-64 text-sm border border-slate-200 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
        />
        {localInputValue && (
          <button
            onClick={handleClear}
            className="absolute right-2 p-1 hover:bg-slate-100 rounded"
            title="Clear search"
          >
            <svg
              className="w-4 h-4 text-slate-400"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        )}
      </div>

      {searchTerm && !isSearching && totalMatches > 0 && (
        <div className="flex items-center space-x-2 text-sm text-slate-600">
          <span className="whitespace-nowrap">
            {currentMatch} / {totalMatches}
          </span>
          <div className="flex items-center space-x-1">
            <button
              onClick={onPrevious}
              disabled={totalMatches === 0}
              className="p-1 hover:bg-slate-100 rounded disabled:opacity-50 disabled:cursor-not-allowed"
              title="Previous match (Shift+Enter)"
            >
              <svg
                className="w-4 h-4"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M15 19l-7-7 7-7"
                />
              </svg>
            </button>
            <button
              onClick={onNext}
              disabled={totalMatches === 0}
              className="p-1 hover:bg-slate-100 rounded disabled:opacity-50 disabled:cursor-not-allowed"
              title="Next match (Enter)"
            >
              <svg
                className="w-4 h-4"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M9 5l7 7-7 7"
                />
              </svg>
            </button>
          </div>
        </div>
      )}

      {isSearching && (
        <div className="flex items-center space-x-2">
          <div className="animate-spin rounded-full h-3 w-3 border-b-2 border-slate-600"></div>
          <span className="text-sm text-slate-500">Searching...</span>
        </div>
      )}

      {searchTerm && !isSearching && totalMatches === 0 && (
        <span className="text-sm text-slate-500">No results</span>
      )}

      <button
        onClick={onClose}
        className="p-1.5 hover:bg-slate-100 rounded-md"
        title="Close (Esc)"
      >
        <svg
          className="w-4 h-4 text-slate-400"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M6 18L18 6M6 6l12 12"
          />
        </svg>
      </button>
    </div>
  );
}
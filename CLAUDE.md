# Parqsee

A fast and simple Parquet file viewer built with Tauri v2, React, and TypeScript.

## Project Overview

Parqsee is a desktop application that allows users to view and explore Apache Parquet files with an intuitive interface. It features:

- Drag-and-drop file loading
- Fast Rust-based backend for efficient file processing
- Pagination for handling large datasets
- Recent files history
- Dark/light mode support
- Cross-platform support (macOS, Windows, Linux)

## Tech Stack

### Frontend
- **React 18.3** - UI framework
- **TypeScript** - Type-safe JavaScript
- **Tailwind CSS v4** - Utility-first CSS framework
- **Vite** - Build tool and dev server

### Backend
- **Tauri v2** - Desktop app framework
- **Rust** - Systems programming language
- **Apache Arrow/Parquet** - For reading Parquet files

## Project Structure

```
Parqsee/
├── src/                    # React frontend source
│   ├── App.tsx            # Main application component
│   ├── components/        # React components
│   │   ├── DataViewer.tsx    # Parquet data display component
│   │   └── SettingsModal.tsx # Settings dialog
│   ├── contexts/          # React context providers
│   │   ├── RecentFilesContext.tsx
│   │   └── SettingsContext.tsx
│   └── main.tsx          # Application entry point
├── src-tauri/            # Rust backend source
│   ├── src/
│   │   ├── lib.rs       # Tauri command handlers
│   │   └── main.rs      # Application entry point
│   ├── Cargo.toml       # Rust dependencies
│   └── tauri.conf.json  # Tauri configuration
├── package.json         # Node.js dependencies
└── vite.config.ts      # Vite configuration
```

## Key Commands

### Development
```bash
npm run dev        # Start Vite dev server (frontend only)
npm run tauri dev  # Start Tauri development mode (full app)
```

### Building
```bash
npm run build        # Build frontend assets
npm run tauri build  # Build production desktop app
```

### Type Checking
```bash
tsc                  # Run TypeScript compiler
```

## Key Features Implementation

### File Handling
- **Drag & Drop**: Implemented in `src/App.tsx` using HTML5 drag events and Tauri file-drop events
- **File Dialog**: Uses `@tauri-apps/plugin-dialog` for native file selection
- **Parquet Reading**: Backend uses `parquet` and `arrow` crates to efficiently read files

### Data Display
- **DataViewer Component** (`src/components/DataViewer.tsx`): Displays Parquet data in a table format
- **Pagination**: Handles large files by loading data in chunks
- **Schema Display**: Shows column names, types, and statistics

### State Management
- **Settings Context**: Manages user preferences (theme, display options)
- **Recent Files Context**: Tracks recently opened files with localStorage persistence

## Tauri Commands

The following commands are exposed from Rust to the frontend:

- `open_parquet_file(path: string)` - Opens and validates a Parquet file
- `get_file_info(path: string)` - Returns file metadata
- `read_parquet_data(path: string, page: number, pageSize: number)` - Reads paginated data
- `get_parquet_schema(path: string)` - Returns file schema information

## Dependencies

### Frontend Dependencies
- `@tauri-apps/api`: Tauri JavaScript API
- `@tauri-apps/plugin-dialog`: File dialog plugin
- `@tauri-apps/plugin-fs`: File system plugin
- `react`, `react-dom`: React framework

### Backend Dependencies
- `tauri`: Core framework
- `parquet`: Apache Parquet reader
- `arrow`: Apache Arrow data structures
- `tokio`: Async runtime
- `serde`, `serde_json`: Serialization

## Configuration Files

- `tauri.conf.json`: Tauri app configuration (window settings, app metadata)
- `vite.config.ts`: Vite bundler configuration
- `tsconfig.json`: TypeScript compiler options
- `tailwind.config.js`: Tailwind CSS configuration

## Development Notes

1. The app uses Tauri v2 which has different APIs than v1
2. File paths must be handled carefully between web and native contexts
3. The Rust backend handles all file I/O for security
4. Recent files are stored in localStorage and synced across sessions
5. Dark mode preference is stored in localStorage

## Testing

Currently, the project doesn't have automated tests configured. To test:
1. Run `npm run tauri dev` for development testing
2. Test drag-and-drop with various Parquet files
3. Verify pagination works with large files
4. Check recent files persistence across sessions

## Building for Production

```bash
npm run tauri build
```

This creates platform-specific installers in `src-tauri/target/release/bundle/`
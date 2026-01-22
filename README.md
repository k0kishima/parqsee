# Parqsee

A fast and simple Parquet file viewer built with Tauri v2, React, and TypeScript.

## Features

- 🚀 **Fast Performance** - Native Rust backend for blazing fast file processing
- 📁 **File Explorer** - VSCode-style sidebar with directory navigation
- 📑 **Multi-Tab Support** - Open multiple Parquet files simultaneously
- 🔍 **Search & Filter** - Full-text search across data with highlighting
- 📊 **Column Sorting** - Sort data by any column (ascending/descending)
- 🎨 **Dark Mode** - Full dark/light theme support
- 🔄 **Pagination** - Efficient handling of large datasets
- 📋 **Recent Files** - Quick access to recently opened files
- ⌨️ **Keyboard Shortcuts** - Cmd+F for search, Cmd+W to close tabs
- 🎯 **Drag & Drop** - Simple file opening by dragging files to the window

## Quick Start

### Prerequisites

- [Node.js](https://nodejs.org/) (version 18 or higher)
- [pnpm](https://pnpm.io/) (package manager)
- [Rust](https://rustup.rs/) (latest stable version)

#### Installing pnpm

If you don't have pnpm installed:

```bash
npm install -g pnpm
```

#### Installing Rust

If you don't have Rust installed, run the following command:

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

### Installation

1. **Clone the repository**
   ```bash
   git clone https://github.com/k0kishima/parqsee.git
   cd parqsee
   ```

2. **Install dependencies**
   Navigate to the frontend directory and install dependencies:
   ```bash
   cd frontend
   pnpm install
   ```

3. **Run the application**
   From the `frontend` directory:
   ```bash
   pnpm tauri dev
   ```

The application will start in development mode and open automatically.

### Building for Production

From the `frontend` directory:

```bash
pnpm tauri build
```

This creates platform-specific installers in `backend/target/release/bundle/` (note: backend artifacts are stored in `backend/target`, not `src-tauri`).

## Usage

### Opening Files

1. **Drag & Drop**: Drag a `.parquet` file onto the application window
2. **File Browser**: Click "Open File" button or use Cmd+O
3. **File Explorer**: Use the left sidebar to navigate and open files from directories

### Navigation

- **File Explorer**: Toggle with the hamburger menu (☰) button
- **Tabs**: Click on tabs to switch between open files
- **Search**: Press Cmd+F (Mac) or Ctrl+F (Windows/Linux) to search within data
- **Sorting**: Click column headers to sort data (click again to reverse)

### Keyboard Shortcuts

- `Cmd+O` / `Ctrl+O` - Open file dialog
- `Cmd+F` / `Ctrl+F` - Open search
- `Cmd+W` / `Ctrl+W` - Close current tab
- `Esc` - Close search or modals

## Tech Stack

### Frontend
- **React 18.3** - UI framework
- **TypeScript** - Type-safe JavaScript
- **Tailwind CSS v4** - Utility-first CSS framework
- **Vite** - Build tool and dev server
- **Lucide React** - Modern icon library
- **pnpm** - Fast, disk space efficient package manager

### Backend
- **Tauri v2** - Desktop app framework
- **Rust** - Systems programming language
- **Apache Arrow/Parquet** - For reading Parquet files

## Project Structure

This project follows a "Bulletproof React" architecture with a clear separation of frontend and backend.

```
parqsee/
├── frontend/                 # React frontend source
│   ├── src/
│   │   ├── features/         # Feature-based groupings
│   │   │   ├── file-viewer/  # Core viewer components & API
│   │   │   ├── file-explorer/# File navigation components & API
│   │   │   ├── settings/     # Settings components & API
│   │   │   ├── welcome/      # Welcome screen
│   │   │   └── layout/       # Shared layout components (TabBar etc.)
│   │   ├── contexts/         # Global state (Settings, RecentFiles)
│   │   ├── App.tsx           # Application shell & routing
│   │   └── main.tsx          # Entry point
│   ├── package.json          # Frontend dependencies
│   └── vite.config.ts        # Vite config
├── backend/                  # Rust backend source (formerly src-tauri)
│   ├── src/
│   │   ├── lib.rs            # Tauri command handlers
│   │   └── main.rs           # Application entry point
│   ├── Cargo.toml            # Rust dependencies
│   └── tauri.conf.json       # Tauri configuration
└── README.md
```

## Development

### Available Scripts (in `frontend/` directory)

- `pnpm dev` - Start Vite dev server (web only)
- `pnpm tauri dev` - Start Tauri development mode (full app)
- `pnpm build` - Build frontend assets
- `pnpm tauri build` - Build production desktop app
- `tsc` - Run TypeScript compiler

### Adding Features

1. **Frontend**: Create a new feature folder in `frontend/src/features/` with `components/`, `api/`, `hooks/`.
2. **Backend**: Add Tauri commands in `backend/src/lib.rs`.
3. **Integration**: Create wrapper functions in your feature's `api/index.ts` to call Tauri commands.

### Tauri Commands

The following commands are exposed from Rust to the frontend:

- `open_parquet_file(path: string)` - Opens and validates a Parquet file
- `get_file_info(path: string)` - Returns file metadata
- `read_parquet_data(path, offset, limit, sort_column?, sort_direction?)` - Reads paginated/sorted data
- `list_directory(path: string)` - Lists files and directories for file explorer
- `check_file_exists(path: string)` - Verifies file existence
- `export_data(...)` - Exports Parquet data to CSV/JSON

## Troubleshooting

### Common Issues

1. **Port 1420 already in use**
   - Another instance is already running
   - Kill the process or restart your terminal

2. **Rust compilation errors**
   - Make sure you have the latest Rust version: `rustup update`
   - Clear Cargo cache: `cargo clean` (inside `backend` directory)

3. **File not opening**
   - Ensure the file has `.parquet` extension
   - Check file permissions
   - Verify the file is not corrupted

### Performance Tips

- For very large files (>1GB), consider using pagination settings
- Use search to find specific data instead of scroll through all rows
- Close unused tabs to free up memory

## Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b feature-name`
3. Make your changes
4. Test thoroughly
5. Submit a pull request

## License

This project is licensed under the MIT License.

## Recommended IDE Setup

- [VS Code](https://code.visualstudio.com/) + [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) + [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)
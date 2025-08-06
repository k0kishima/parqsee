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
- [Rust](https://rustup.rs/) (latest stable version)

#### Installing Rust

If you don't have Rust installed, run the following command:

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

After installation, restart your terminal or run:

```bash
source "$HOME/.cargo/env"
```

Verify the installation:

```bash
rustc --version
cargo --version
```

### Installation

1. **Clone the repository**
   ```bash
   git clone https://github.com/k0kishima/parqsee.git
   cd parqsee
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Run the application**
   ```bash
   npm run tauri dev
   ```

The application will start in development mode and open automatically.

### Building for Production

```bash
npm run tauri build
```

This creates platform-specific installers in `src-tauri/target/release/bundle/`

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

### Backend
- **Tauri v2** - Desktop app framework
- **Rust** - Systems programming language
- **Apache Arrow/Parquet** - For reading Parquet files

## Project Structure

```
parqsee/
├── src/                    # React frontend source
│   ├── App.tsx            # Main application component
│   ├── components/        # React components
│   │   ├── DataViewer.tsx    # Parquet data display
│   │   ├── FileExplorer.tsx  # File navigation sidebar
│   │   ├── TabBar.tsx        # Multi-file tab management
│   │   ├── SearchBar.tsx     # Search functionality
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

## Development

### Available Scripts

- `npm run dev` - Start Vite dev server (frontend only)
- `npm run tauri dev` - Start Tauri development mode (full app)
- `npm run build` - Build frontend assets
- `npm run tauri build` - Build production desktop app
- `tsc` - Run TypeScript compiler

### Adding Features

1. **Frontend Components**: Add React components in `src/components/`
2. **Backend Commands**: Add Tauri commands in `src-tauri/src/lib.rs`
3. **Styling**: Use Tailwind CSS classes with dark mode support
4. **State Management**: Use React Context for global state

### Tauri Commands

The following commands are exposed from Rust to the frontend:

- `open_parquet_file(path: string)` - Opens and validates a Parquet file
- `get_file_info(path: string)` - Returns file metadata
- `read_parquet_data(path, offset, limit, sort_column?, sort_direction?)` - Reads paginated/sorted data
- `list_directory(path: string)` - Lists files and directories for file explorer

## Troubleshooting

### Common Issues

1. **Port 1420 already in use**
   - Another instance is already running
   - Kill the process or restart your terminal

2. **Rust compilation errors**
   - Make sure you have the latest Rust version: `rustup update`
   - Clear Cargo cache: `cargo clean`

3. **File not opening**
   - Ensure the file has `.parquet` extension
   - Check file permissions
   - Verify the file is not corrupted

### Performance Tips

- For very large files (>1GB), consider using pagination settings
- Use search to find specific data instead of scrolling through all rows
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
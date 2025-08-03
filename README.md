# Obsidianotion - Notion to Obsidian Sync Plugin

A comprehensive Obsidian plugin that syncs your Notion workspace to Obsidian with intelligent folder mapping and file organization.

## Features

### 🔄 Intelligent Sync
- **Hierarchical Mapping**: 
  - Root pages → Obsidian folders
  - Sub-pages → Markdown files  
  - Database pages → folders with database entries as markdown files
- **Incremental Sync**: Only updates changed content
- **Bidirectional Detection**: Handles page moves and deletions in Notion

### 🗂️ Advanced Organization
- **Root Folder Configuration**: Organize all synced content under a custom directory
- **Image Management**: Automatic image download with configurable storage paths
- **Path Independence**: Images and content use separate, configurable folder structures

### 🔧 Smart Features
- **Auto Delete**: Removes files in Obsidian when corresponding Notion pages are deleted
- **Move Detection**: Automatically relocates files when page hierarchy changes in Notion
- **Duplicate Prevention**: Avoids re-downloading existing images and content

## Setup

### Prerequisites
1. **Notion Integration**: Create a Notion integration at https://www.notion.so/my-integrations
2. **Database Access**: Share your Notion databases/pages with the integration
3. **Obsidian**: Version 1.0.0 or higher

### Installation
1. Download and extract the plugin files to your vault's `.obsidian/plugins/obsidiantion/` folder
2. Enable the plugin in Obsidian Settings → Community Plugins
3. Configure your Notion integration token in the plugin settings

## Configuration

### Basic Setup
1. **Notion Secret Key**: Paste your Notion Internal Integration Token
2. **Root Folder Path**: (Optional) Set a base directory for all synced content
   - Leave empty to sync to vault root
   - Example: `Notion` creates all content under a `Notion/` folder
3. **Image Folder Path**: Set where downloaded images are stored
   - Default: `attachments`
   - Independent of root folder path
4. **Auto Sync Interval**: Configure automatic sync frequency (0-120 minutes)

### Advanced Options
- **Auto Delete Missing Pages**: Automatically remove files when Notion pages are deleted
- **Manual Sync**: Use "Sync Now" button for immediate synchronization

## Usage

### First Time Sync
1. Configure your Notion secret key in plugin settings
2. Set your preferred folder structure (root folder and image folder)
3. Click "Sync Now" to perform initial synchronization
4. Check the console (Developer Tools) for detailed sync logs

### Ongoing Usage
- **Automatic Sync**: Enable auto-sync for hands-off operation
- **Manual Sync**: Use "Sync Now" when you need immediate updates
- **File Organization**: Files automatically organize based on Notion hierarchy

## File Organization Examples

### Default Configuration
```
Root Folder Path: (empty)
Image Folder Path: attachments
```

Result:
```
Obsidian Vault/
├── Work Project/           ← Notion root page
│   ├── Meeting Notes.md    ← Notion sub-page
│   └── Tasks Database/     ← Notion database
│       ├── Task 1.md       ← Database entry
│       └── Task 2.md       ← Database entry
├── Personal/               ← Another root page
│   └── Ideas.md
└── attachments/            ← Images (independent)
    ├── image1.png
    └── image2.jpg
```

### Custom Root Folder
```
Root Folder Path: Notion
Image Folder Path: media
```

Result:
```
Obsidian Vault/
├── Notion/                 ← All content under custom root
│   ├── Work Project/
│   │   ├── Meeting Notes.md
│   │   └── Tasks Database/
│   │       ├── Task 1.md
│   │       └── Task 2.md
│   └── Personal/
│       └── Ideas.md
└── media/                  ← Images in separate location
    ├── image1.png
    └── image2.jpg
```

## Troubleshooting

### Common Issues

#### Sync Errors
- **"Notion client not configured"**: Add your Notion integration token
- **"Failed to execute 'fetch'"**: Plugin uses Obsidian's built-in network APIs for compatibility
- **"Permission denied"**: Ensure your Notion integration has access to the databases/pages

#### File Organization
- **Files not in root folder**: Check that root folder path is configured correctly
- **Images in wrong location**: Verify image folder path setting (independent of root folder)
- **Old files not moved**: Plugin doesn't automatically relocate existing files when changing settings

#### Performance
- **Slow sync**: Large workspaces may take time; check console for progress
- **Memory issues**: Restart Obsidian if sync fails repeatedly

### Debug Mode
1. Open Developer Tools (`Cmd+Option+I` on Mac, `Ctrl+Shift+I` on Windows)
2. Switch to Console tab
3. Run sync and observe detailed logs
4. Look for setting values and path construction messages

### Reset Configuration
If issues persist:
1. Close Obsidian
2. Delete `.obsidian/plugins/obsidiantion/data.json`
3. Restart Obsidian and reconfigure the plugin

## Development

### Building from Source
```bash
# Install dependencies
npm install

# Development build (watch mode)
npm run dev

# Production build
npm run build
```

### Project Structure
- `main.ts`: Core plugin implementation
- `manifest.json`: Plugin metadata
- `package.json`: Build configuration

## Support

### Getting Help
For issues or questions:
1. Check the troubleshooting section above
2. Enable debug mode and check console logs
3. Provide the following when reporting issues:
   - Console logs
   - Plugin settings screenshot
   - Vault file structure
   - Operating system information

### Contributing
Contributions are welcome! Please feel free to submit issues and enhancement requests.

## License

This project is licensed under the MIT License - see the LICENSE file for details.

```json
{
    "fundingUrl": "https://buymeacoffee.com"
}
```

If you have multiple URLs, you can also do:

```json
{
    "fundingUrl": {
        "Buy Me a Coffee": "https://buymeacoffee.com",
        "GitHub Sponsor": "https://github.com/sponsors",
        "Patreon": "https://www.patreon.com/"
    }
}
```

## API Documentation

See https://github.com/obsidianmd/obsidian-api

import { App, Editor, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting, TFile, TFolder, requestUrl } from 'obsidian';

interface NotionSyncSettings {
	notionSecret: string;
	syncInterval: number; // in minutes
	lastSyncTime: number;
	autoDeleteMissingPages: boolean;
	rootFolderPath: string; // Root folder for all synced content (empty = vault root)
	imageFolderPath: string; // Path for storing images (empty = root)
	filteredPageIds: string[]; // List of Notion page IDs to exclude from sync
	syncedPages: Record<string, { path: string; lastModified: string; notionId: string }>;
	syncedImages: Record<string, { path: string; notionUrl: string; hash: string }>; // Track synced images
}

const DEFAULT_SETTINGS: NotionSyncSettings = {
	notionSecret: '',
	syncInterval: 30,
	lastSyncTime: 0,
	autoDeleteMissingPages: true,
	rootFolderPath: '',
	imageFolderPath: 'attachments',
	filteredPageIds: [],
	syncedPages: {},
	syncedImages: {}
}

interface NotionPage {
	id: string;
	title: string;
	lastModified: string;
	parent?: string;
	type: 'page' | 'database';
}

interface NotionBlock {
	id: string;
	type: string;
	content: string;
	children?: NotionBlock[];
}

export default class ObsidiantionPlugin extends Plugin {
	settings: NotionSyncSettings;
	syncIntervalId: number | null = null;

	async onload() {
		await this.loadSettings();

		// Add ribbon icon for manual sync
		const ribbonIconEl = this.addRibbonIcon('sync', 'Sync with Notion', async (evt: MouseEvent) => {
			if (!this.settings.notionSecret) {
				new Notice('Please configure Notion secret key in settings first!');
				return;
			}
			await this.syncAllPages();
		});
		ribbonIconEl.addClass('obsidiantion-ribbon-class');

		// Add status bar item
		const statusBarItemEl = this.addStatusBarItem();
		statusBarItemEl.setText('Obsidiantion Ready');

		// Add command for manual sync
		this.addCommand({
			id: 'sync-notion-pages',
			name: 'Sync Notion Pages',
			callback: async () => {
				if (!this.settings.notionSecret) {
					new Notice('Please configure Notion secret key in settings first!');
					return;
				}
				await this.syncAllPages();
			}
		});

		// Add command to open sync settings
		this.addCommand({
			id: 'open-notion-sync-settings',
			name: 'Open Notion Sync Settings',
			callback: () => {
				// @ts-ignore
				this.app.setting.open();
				// @ts-ignore
				this.app.setting.openTabById('obsidiantion');
			}
		});

		// Add settings tab
		this.addSettingTab(new NotionSyncSettingTab(this.app, this));

		// Start automatic sync if configured
		this.startAutoSync();
	}

	onunload() {
		this.stopAutoSync();
	}

	startAutoSync() {
		if (this.settings.syncInterval > 0 && this.settings.notionSecret) {
			this.syncIntervalId = window.setInterval(async () => {
				await this.syncAllPages();
			}, this.settings.syncInterval * 60 * 1000);
		}
	}

	stopAutoSync() {
		if (this.syncIntervalId) {
			window.clearInterval(this.syncIntervalId);
			this.syncIntervalId = null;
		}
	}

	async makeNotionRequest(endpoint: string, method: string = 'GET', body?: any): Promise<any> {
		const url = `https://api.notion.com/v1/${endpoint}`;

		try {
			const response = await requestUrl({
				url: url,
				method: method,
				headers: {
					'Authorization': `Bearer ${this.settings.notionSecret}`,
					'Content-Type': 'application/json',
					'Notion-Version': '2022-06-28'
				},
				body: body ? JSON.stringify(body) : undefined
			});

			return response.json;
		} catch (error) {
			console.error('Notion API request failed:', error);
			throw new Error(`Notion API request failed: ${error.message}`);
		}
	}

	async syncAllPages() {
		if (!this.settings.notionSecret) {
			new Notice('Notion client not configured');
			return;
		}

		try {
			// Debug: Log current settings
			console.log('Current plugin settings:', {
				rootFolderPath: this.settings.rootFolderPath,
				imageFolderPath: this.settings.imageFolderPath,
				autoDeleteMissingPages: this.settings.autoDeleteMissingPages
			});

			new Notice('Starting Notion sync...');

			// Get all pages from Notion workspace
			const pages = await this.getAllNotionPages();

			// Check for deleted pages and remove them (if enabled)
			if (this.settings.autoDeleteMissingPages) {
				await this.removeDeletedPages(pages);
			}

			// Handle page moves before processing hierarchy
			await this.handlePageMoves(pages);

			// Process root pages and their hierarchies
			await this.processNotionHierarchy(pages);

			this.settings.lastSyncTime = Date.now();
			await this.saveSettings();

			new Notice(`Sync completed! Processed ${pages.length} pages.`);
		} catch (error) {
			console.error('Sync failed:', error);
			new Notice(`Sync failed: ${error.message}`);
		}
	}

	async getAllNotionPages(): Promise<NotionPage[]> {
		const pages: NotionPage[] = [];
		let cursor: string | undefined;

		do {
			const searchBody: any = {
				filter: {
					property: 'object',
					value: 'page'
				},
				page_size: 100
			};

			if (cursor) {
				searchBody.start_cursor = cursor;
			}

			const response = await this.makeNotionRequest('search', 'POST', searchBody);

			for (const page of response.results) {
				if ('properties' in page && 'last_edited_time' in page) {
					const title = this.extractPageTitle(page);
					const parent = 'parent' in page && page.parent ?
						(page.parent.type === 'page_id' ? page.parent.page_id :
							page.parent.type === 'database_id' ? page.parent.database_id : undefined) : undefined;

					// Skip filtered pages
					if (this.isPageFiltered(page.id)) {
						console.log(`Skipping filtered page: ${title} (${page.id})`);
						continue;
					}

					pages.push({
						id: page.id,
						title: title,
						lastModified: page.last_edited_time,
						parent: parent,
						type: 'page'
					});
				}
			}

			cursor = response.next_cursor || undefined;
		} while (cursor);

		// Also get databases
		cursor = undefined;
		do {
			const searchBody: any = {
				filter: {
					property: 'object',
					value: 'database'
				},
				page_size: 100
			};

			if (cursor) {
				searchBody.start_cursor = cursor;
			}

			const response = await this.makeNotionRequest('search', 'POST', searchBody);

			for (const db of response.results) {
				if ('title' in db && 'last_edited_time' in db) {
					const title = (db.title as any[]).map((t: any) => t.plain_text).join('');
					const parent = 'parent' in db && db.parent && db.parent.type === 'page_id' ?
						db.parent.page_id : undefined;

					// Skip filtered databases
					if (this.isPageFiltered(db.id)) {
						console.log(`Skipping filtered database: ${title} (${db.id})`);
						continue;
					}

					pages.push({
						id: db.id,
						title: title,
						lastModified: db.last_edited_time,
						parent: parent,
						type: 'database'
					});
				}
			}

			cursor = response.next_cursor || undefined;
		} while (cursor);

		return pages;
	}

	async removeDeletedPages(currentPages: NotionPage[]) {
		const currentPageIds = new Set(currentPages.map(page => page.id));
		const deletedPages: string[] = [];
		const filesToDelete: string[] = [];

		// Find pages that were previously synced but no longer exist in Notion OR are now filtered out
		for (const [pageId, syncRecord] of Object.entries(this.settings.syncedPages)) {
			if (!currentPageIds.has(pageId) || this.isPageFiltered(pageId)) {
				deletedPages.push(pageId);
				filesToDelete.push(syncRecord.path);
			}
		}

		if (deletedPages.length === 0) {
			return;
		}

		new Notice(`Found ${deletedPages.length} deleted/filtered pages, removing from Obsidian...`);

		// Remove files from Obsidian vault
		for (const filePath of filesToDelete) {
			try {
				const file = this.app.vault.getAbstractFileByPath(filePath);
				if (file) {
					await this.app.vault.delete(file);
					console.log(`Deleted file: ${filePath}`);
				}
			} catch (error) {
				console.error(`Failed to delete file ${filePath}:`, error);
			}
		}

		// Clean up empty folders
		await this.cleanupEmptyFolders();

		// Clean up orphaned images
		await this.cleanupOrphanedImages();

		// Remove from sync records
		for (const pageId of deletedPages) {
			delete this.settings.syncedPages[pageId];
		}

		await this.saveSettings();

		if (deletedPages.length > 0) {
			new Notice(`Removed ${deletedPages.length} deleted/filtered pages from Obsidian`);
		}
	}

	async cleanupEmptyFolders() {
		// Get all folders in the vault
		const folders = this.app.vault.getAllLoadedFiles()
			.filter(file => file instanceof TFolder) as TFolder[];

		// Sort by path length (deepest first) to clean up from bottom up
		folders.sort((a, b) => b.path.length - a.path.length);

		for (const folder of folders) {
			try {
				// Check if folder is empty
				const children = folder.children;
				if (children.length === 0) {
					// Check if this folder was created by our plugin
					// (contains only files that were synced from Notion)
					const wasSyncedFolder = Object.values(this.settings.syncedPages)
						.some(record => record.path.startsWith(folder.path + '/'));

					if (wasSyncedFolder) {
						await this.app.vault.delete(folder);
						console.log(`Deleted empty folder: ${folder.path}`);
					}
				}
			} catch (error) {
				console.error(`Failed to delete empty folder ${folder.path}:`, error);
			}
		}
	}

	async cleanupOrphanedImages() {
		const orphanedImages: string[] = [];
		const allFileContents = new Set<string>();

		// Collect all content from synced markdown files
		for (const syncRecord of Object.values(this.settings.syncedPages)) {
			try {
				const file = this.app.vault.getAbstractFileByPath(syncRecord.path);
				if (file instanceof TFile) {
					const content = await this.app.vault.read(file);
					allFileContents.add(content);
				}
			} catch (error) {
				console.error(`Failed to read file ${syncRecord.path}:`, error);
			}
		}

		// Check each synced image to see if it's still referenced
		for (const [imageUrl, imageRecord] of Object.entries(this.settings.syncedImages)) {
			let isReferenced = false;

			// Check if any file content references this image
			for (const content of allFileContents) {
				if (content.includes(imageRecord.path)) {
					isReferenced = true;
					break;
				}
			}

			if (!isReferenced) {
				orphanedImages.push(imageRecord.path);

				// Delete the orphaned image file
				try {
					const imageFile = this.app.vault.getAbstractFileByPath(imageRecord.path);
					if (imageFile) {
						await this.app.vault.delete(imageFile);
						console.log(`Deleted orphaned image: ${imageRecord.path}`);
					}
				} catch (error) {
					console.error(`Failed to delete orphaned image ${imageRecord.path}:`, error);
				}

				// Remove from sync records
				delete this.settings.syncedImages[imageUrl];
			}
		}

		if (orphanedImages.length > 0) {
			console.log(`Cleaned up ${orphanedImages.length} orphaned images`);
			await this.saveSettings();
		}
	}

	async handlePageMoves(currentPages: NotionPage[]) {
		const movedPages: Array<{ pageId: string, oldPath: string, newPath: string }> = [];

		// Create a map of current pages for quick lookup
		const currentPagesMap = new Map(currentPages.map(page => [page.id, page]));

		// Check each previously synced page to see if its location has changed
		for (const [pageId, syncRecord] of Object.entries(this.settings.syncedPages)) {
			const currentPage = currentPagesMap.get(pageId);

			if (currentPage) {
				// Calculate what the new path should be based on current page hierarchy
				const newPath = await this.calculatePagePath(currentPage, currentPages);

				if (newPath !== syncRecord.path) {
					movedPages.push({
						pageId: pageId,
						oldPath: syncRecord.path,
						newPath: newPath
					});
				}
			}
		}

		if (movedPages.length === 0) {
			return;
		}

		new Notice(`Found ${movedPages.length} moved pages, updating locations...`);

		// Move files in Obsidian
		for (const move of movedPages) {
			try {
				const oldFile = this.app.vault.getAbstractFileByPath(move.oldPath);
				if (oldFile instanceof TFile) {
					// Ensure the new directory exists
					const newDir = move.newPath.substring(0, move.newPath.lastIndexOf('/'));
					if (newDir) {
						await this.ensureFolder(newDir);
					}

					// Move the file
					await this.app.vault.rename(oldFile, move.newPath);
					console.log(`Moved file from ${move.oldPath} to ${move.newPath}`);

					// Update sync record
					this.settings.syncedPages[move.pageId].path = move.newPath;
				}
			} catch (error) {
				console.error(`Failed to move file from ${move.oldPath} to ${move.newPath}:`, error);
			}
		}

		// Clean up empty folders after moving files
		await this.cleanupEmptyFolders();

		await this.saveSettings();

		if (movedPages.length > 0) {
			new Notice(`Moved ${movedPages.length} pages to new locations`);
		}
	}

	async calculatePagePath(page: NotionPage, allPages: NotionPage[]): Promise<string> {
		// If this is a root page (no parent), it should be a folder, not a file
		if (!page.parent) {
			return '';
		}

		const pathParts: string[] = [];
		let currentPageId: string | undefined = page.parent;

		// Traverse up the hierarchy to build the path
		while (currentPageId) {
			const parentPage = allPages.find(p => p.id === currentPageId);
			if (!parentPage) {
				break;
			}

			if (parentPage.type === 'database') {
				// Database becomes a folder
				pathParts.unshift(this.sanitizeFileName(parentPage.title));
				currentPageId = parentPage.parent;
			} else if (parentPage.type === 'page') {
				if (!parentPage.parent) {
					// This is a root page, becomes the top-level folder
					pathParts.unshift(this.sanitizeFileName(parentPage.title));
					break;
				} else {
					// This is a sub-page, continue traversing
					currentPageId = parentPage.parent;
				}
			} else {
				break;
			}
		}

		// Add the current page as the file name
		pathParts.push(this.sanitizeFileName(page.title) + '.md');

		// Use buildFullPath to respect root folder setting
		return this.buildFullPath(pathParts.join('/'));
	}

	extractPageTitle(page: any): string {
		const titleProperty = Object.values(page.properties).find((prop: any) => prop.type === 'title') as any;
		if (titleProperty && titleProperty.title && titleProperty.title.length > 0) {
			return titleProperty.title.map((t: any) => t.plain_text).join('');
		}
		return 'Untitled';
	}

	async processNotionHierarchy(pages: NotionPage[]) {
		// Find root pages (pages without parent or with workspace parent)
		const rootPages = pages.filter(page => !page.parent || page.parent === 'workspace');

		for (const rootPage of rootPages) {
			await this.processRootPage(rootPage, pages);
		}
	}

	async processRootPage(rootPage: NotionPage, allPages: NotionPage[]) {
		// Create folder for root page
		const folderName = this.sanitizeFileName(rootPage.title);
		const fullFolderPath = this.buildFullPath(folderName);
		await this.ensureFolder(fullFolderPath);

		// Find children of this root page
		const children = allPages.filter(page => page.parent === rootPage.id);

		for (const child of children) {
			if (child.type === 'database') {
				// Database becomes a subfolder
				const dbFolderPath = this.buildFullPath(`${folderName}/${this.sanitizeFileName(child.title)}`);
				await this.ensureFolder(dbFolderPath);

				// Get database entries
				const dbEntries = allPages.filter(page => page.parent === child.id);
				for (const entry of dbEntries) {
					const filePath = this.buildFullPath(`${folderName}/${this.sanitizeFileName(child.title)}/${this.sanitizeFileName(entry.title)}.md`);
					await this.syncPageToFile(entry, filePath);
				}
			} else {
				// Regular page becomes a markdown file
				const filePath = this.buildFullPath(`${folderName}/${this.sanitizeFileName(child.title)}.md`);
				await this.syncPageToFile(child, filePath);
			}
		}
	}

	async syncPageToFile(page: NotionPage, filePath: string) {
		// Check if file already exists and if it needs updating
		const existingFile = this.app.vault.getAbstractFileByPath(filePath);
		const syncRecord = this.settings.syncedPages[page.id];

		if (syncRecord && existingFile && syncRecord.lastModified === page.lastModified) {
			// No update needed
			return;
		}

		try {
			// Get page content from Notion
			const content = await this.getPageContent(page);

			if (existingFile instanceof TFile) {
				// Update existing file
				await this.app.vault.modify(existingFile, content);
			} else {
				// Create new file
				await this.app.vault.create(filePath, content);
			}

			// Update sync record
			this.settings.syncedPages[page.id] = {
				path: filePath,
				lastModified: page.lastModified,
				notionId: page.id
			};

			await this.saveSettings();
		} catch (error) {
			console.error(`Failed to sync page ${page.title}:`, error);
		}
	}

	async getPageContent(page: NotionPage): Promise<string> {
		try {
			const blocks = await this.getPageBlocks(page.id);
			const properties = await this.getPageProperties(page.id);

			let content = `# ${page.title}\n\n`;

			// Add tags from select properties
			const tags = this.extractTagsFromProperties(properties);
			if (tags.length > 0) {
				content += tags.map(tag => `#${tag}`).join(' ') + '\n\n';
			}

			content += `> Synced from Notion on ${new Date().toISOString()}\n\n`;
			content += this.convertBlocksToMarkdown(blocks);
			return content;
		} catch (error) {
			console.error(`Failed to get content for page ${page.title}:`, error);
			return `# ${page.title}\n\n> Failed to sync content from Notion\n`;
		}
	}

	async getPageBlocks(pageId: string): Promise<NotionBlock[]> {
		const blocks: NotionBlock[] = [];
		let cursor: string | undefined;

		do {
			const endpoint = `blocks/${pageId}/children`;
			const params = new URLSearchParams();
			params.append('page_size', '100');
			if (cursor) {
				params.append('start_cursor', cursor);
			}

			const response = await this.makeNotionRequest(`${endpoint}?${params.toString()}`);

			for (const block of response.results) {
				blocks.push(await this.convertNotionBlock(block));
			}

			cursor = response.next_cursor || undefined;
		} while (cursor);

		return blocks;
	}

	async getPageProperties(pageId: string): Promise<any> {
		try {
			const response = await this.makeNotionRequest(`pages/${pageId}`);
			return response.properties || {};
		} catch (error) {
			console.error(`Failed to get properties for page ${pageId}:`, error);
			return {};
		}
	}

	extractTagsFromProperties(properties: any): string[] {
		const tags: string[] = [];

		// Iterate through all properties
		for (const [propertyName, property] of Object.entries(properties)) {
			const prop = property as any;

			// Check for select property type
			if (prop.type === 'select' && prop.select && prop.select.name) {
				// Sanitize the tag name to be valid for Obsidian
				const tagName = this.sanitizeTagName(prop.select.name);
				if (tagName) {
					tags.push(tagName);
				}
			}

			// Check for multi_select property type
			if (prop.type === 'multi_select' && prop.multi_select && Array.isArray(prop.multi_select)) {
				for (const option of prop.multi_select) {
					if (option.name) {
						const tagName = this.sanitizeTagName(option.name);
						if (tagName) {
							tags.push(tagName);
						}
					}
				}
			}
		}

		return tags;
	}

	sanitizeTagName(name: string): string {
		// Remove or replace characters that are not valid in Obsidian tags
		// Obsidian tags can contain letters, numbers, underscores, and hyphens
		// but cannot contain spaces or special characters
		return name
			.replace(/[^\w\-]/g, '_') // Replace non-word characters (except hyphens) with underscores
			.replace(/^_+|_+$/g, '') // Remove leading and trailing underscores
			.replace(/_+/g, '_'); // Replace multiple underscores with single underscore
	}

	async convertNotionBlock(block: any): Promise<NotionBlock> {
		const notionBlock: NotionBlock = {
			id: block.id,
			type: block.type,
			content: ''
		};

		switch (block.type) {
			case 'paragraph':
				notionBlock.content = this.extractRichText(block.paragraph.rich_text);
				break;
			case 'heading_1':
				notionBlock.content = `# ${this.extractRichText(block.heading_1.rich_text)}`;
				break;
			case 'heading_2':
				notionBlock.content = `## ${this.extractRichText(block.heading_2.rich_text)}`;
				break;
			case 'heading_3':
				notionBlock.content = `### ${this.extractRichText(block.heading_3.rich_text)}`;
				break;
			case 'bulleted_list_item':
				notionBlock.content = `- ${this.extractRichText(block.bulleted_list_item.rich_text)}`;
				break;
			case 'numbered_list_item':
				notionBlock.content = `1. ${this.extractRichText(block.numbered_list_item.rich_text)}`;
				break;
			case 'code':
				const language = block.code.language || '';
				const code = this.extractRichText(block.code.rich_text);
				notionBlock.content = `\`\`\`${language}\n${code}\n\`\`\``;
				break;
			case 'quote':
				notionBlock.content = `> ${this.extractRichText(block.quote.rich_text)}`;
				break;
			case 'image':
				notionBlock.content = await this.handleImageBlock(block);
				break;
			case 'file':
				notionBlock.content = await this.handleFileBlock(block);
				break;
			default:
				notionBlock.content = `<!-- Unsupported block type: ${block.type} -->`;
		}

		// Handle child blocks if they exist
		if (block.has_children) {
			try {
				notionBlock.children = await this.getPageBlocks(block.id);
			} catch (error) {
				console.warn(`Failed to get child blocks for ${block.id}:`, error);
				notionBlock.children = [];
			}
		}

		return notionBlock;
	}

	extractRichText(richText: any[]): string {
		return richText.map(text => {
			let content = text.plain_text;

			if (text.annotations.bold) content = `**${content}**`;
			if (text.annotations.italic) content = `*${content}*`;
			if (text.annotations.code) content = `\`${content}\``;
			if (text.annotations.strikethrough) content = `~~${content}~~`;

			if (text.href) content = `[${content}](${text.href})`;

			return content;
		}).join('');
	}

	async handleImageBlock(block: any): Promise<string> {
		try {
			const imageData = block.image;
			let imageUrl: string;
			let caption = '';

			// Extract image URL based on type
			if (imageData.type === 'external') {
				imageUrl = imageData.external.url;
			} else if (imageData.type === 'file') {
				imageUrl = imageData.file.url;
			} else {
				return `<!-- Unsupported image type: ${imageData.type} -->`;
			}

			// Extract caption if available
			if (imageData.caption && imageData.caption.length > 0) {
				caption = this.extractRichText(imageData.caption);
			}

			// Download and save the image
			const localImagePath = await this.downloadAndSaveImage(imageUrl, caption);

			if (localImagePath) {
				// Return markdown image syntax
				const altText = caption || 'Image';
				return `![${altText}](${localImagePath})`;
			} else {
				// Fallback to external URL if download fails
				const altText = caption || 'Image';
				return `![${altText}](${imageUrl})`;
			}
		} catch (error) {
			console.error('Error handling image block:', error);
			return `<!-- Failed to process image -->`;
		}
	}

	async handleFileBlock(block: any): Promise<string> {
		try {
			const fileData = block.file;
			let fileUrl: string;
			let filename = 'file';

			// Extract file URL based on type
			if (fileData.type === 'external') {
				fileUrl = fileData.external.url;
			} else if (fileData.type === 'file') {
				fileUrl = fileData.file.url;
			} else {
				return `<!-- Unsupported file type: ${fileData.type} -->`;
			}

			// Extract filename from caption or URL
			if (fileData.caption && fileData.caption.length > 0) {
				filename = this.extractRichText(fileData.caption);
			} else {
				// Try to extract filename from URL
				const urlParts = fileUrl.split('/');
				const lastPart = urlParts[urlParts.length - 1];
				if (lastPart && lastPart.includes('.')) {
					filename = lastPart.split('?')[0]; // Remove query parameters
				}
			}

			// For images in file blocks, download them
			if (this.isImageFile(fileUrl)) {
				const localImagePath = await this.downloadAndSaveImage(fileUrl, filename);
				if (localImagePath) {
					return `![${filename}](${localImagePath})`;
				}
			}

			// For other files, just create a link
			return `[${filename}](${fileUrl})`;
		} catch (error) {
			console.error('Error handling file block:', error);
			return `<!-- Failed to process file -->`;
		}
	}

	isImageFile(url: string): boolean {
		const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.svg', '.webp'];
		const urlLower = url.toLowerCase();
		return imageExtensions.some(ext => urlLower.includes(ext));
	}

	async downloadAndSaveImage(imageUrl: string, originalName: string): Promise<string | null> {
		try {
			// Check if image already exists in sync records
			const existingImage = this.settings.syncedImages[imageUrl];
			if (existingImage) {
				// Check if the file still exists in the vault
				const existingFile = this.app.vault.getAbstractFileByPath(existingImage.path);
				if (existingFile) {
					console.log(`Image already exists: ${existingImage.path}`);
					return existingImage.path;
				} else {
					// File was deleted, remove from sync records
					delete this.settings.syncedImages[imageUrl];
				}
			}

			// Generate a unique filename
			const timestamp = Date.now();
			const fileExtension = this.getFileExtension(imageUrl);
			const safeName = this.sanitizeFileName(originalName || 'image');
			const filename = `${safeName}_${timestamp}${fileExtension}`;

			// Determine the full path for the image (independent of root folder)
			const imageFolderPath = this.settings.imageFolderPath.trim();
			const fullPath = imageFolderPath ? `${imageFolderPath}/${filename}` : filename;

			// Create the image folder if it doesn't exist
			if (imageFolderPath) {
				await this.ensureFolder(imageFolderPath);
			}

			// Download the image
			const response = await requestUrl({
				url: imageUrl,
				method: 'GET'
			});

			if (response.arrayBuffer) {
				// Save the image to the vault
				const imageFile = await this.app.vault.createBinary(fullPath, response.arrayBuffer);

				// Store in sync records
				const imageHash = await this.generateImageHash(response.arrayBuffer);
				this.settings.syncedImages[imageUrl] = {
					path: fullPath,
					notionUrl: imageUrl,
					hash: imageHash
				};
				await this.saveSettings();

				console.log(`Downloaded image: ${fullPath}`);
				return fullPath;
			}
		} catch (error) {
			console.error(`Failed to download image from ${imageUrl}:`, error);
		}

		return null;
	}

	getFileExtension(url: string): string {
		const urlWithoutQuery = url.split('?')[0];
		const match = urlWithoutQuery.match(/\.([a-zA-Z0-9]+)$/);
		if (match) {
			return `.${match[1]}`;
		}
		// Default to .png if no extension found
		return '.png';
	}

	async generateImageHash(arrayBuffer: ArrayBuffer): Promise<string> {
		// Simple hash based on file size and first few bytes
		const bytes = new Uint8Array(arrayBuffer);
		let hash = arrayBuffer.byteLength.toString();

		// Add first 10 bytes to hash if available
		for (let i = 0; i < Math.min(10, bytes.length); i++) {
			hash += bytes[i].toString(16);
		}

		return hash;
	}

	convertBlocksToMarkdown(blocks: NotionBlock[]): string {
		return blocks.map(block => {
			let content = block.content;
			if (block.children && block.children.length > 0) {
				const childContent = this.convertBlocksToMarkdown(block.children);
				content += '\n' + childContent.split('\n').map(line => '  ' + line).join('\n');
			}
			return content;
		}).join('\n\n');
	}

	sanitizeFileName(name: string): string {
		return name.replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, ' ').trim();
	}

	buildFullPath(relativePath: string): string {
		const rootPath = this.settings.rootFolderPath.trim();
		if (rootPath) {
			const fullPath = `${rootPath}/${relativePath}`;
			console.log(`BuildFullPath: root="${rootPath}", relative="${relativePath}", full="${fullPath}"`);
			return fullPath;
		}
		console.log(`BuildFullPath: no root, using relative="${relativePath}"`);
		return relativePath;
	}

	async ensureFolder(folderPath: string) {
		const folder = this.app.vault.getAbstractFileByPath(folderPath);
		if (!folder) {
			await this.app.vault.createFolder(folderPath);
		}
	}

	isPageFiltered(pageId: string): boolean {
		// Normalize both the page ID and filtered IDs by removing hyphens for comparison
		const normalizedPageId = pageId.replace(/-/g, '');
		return this.settings.filteredPageIds.some(filteredId => {
			const normalizedFilteredId = filteredId.replace(/-/g, '');
			return normalizedPageId === normalizedFilteredId;
		});
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

class NotionSyncModal extends Modal {
	plugin: ObsidiantionPlugin;

	constructor(app: App, plugin: ObsidiantionPlugin) {
		super(app);
		this.plugin = plugin;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.setText('Notion Sync Status');

		// Add sync status information
		const statusDiv = contentEl.createDiv();
		const lastSync = this.plugin.settings.lastSyncTime;
		if (lastSync > 0) {
			statusDiv.setText(`Last sync: ${new Date(lastSync).toLocaleString()}`);
		} else {
			statusDiv.setText('Never synced');
		}

		// Add manual sync button
		const syncButton = contentEl.createEl('button', { text: 'Sync Now' });
		syncButton.addEventListener('click', async () => {
			await this.plugin.syncAllPages();
			this.close();
		});
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}

class NotionSyncSettingTab extends PluginSettingTab {
	plugin: ObsidiantionPlugin;

	constructor(app: App, plugin: ObsidiantionPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl('h2', { text: 'Obsidiantion Settings' });

		new Setting(containerEl)
			.setName('Notion Secret Key')
			.setDesc('Enter your Notion integration secret key')
			.addText(text => text
				.setPlaceholder('secret_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx')
				.setValue(this.plugin.settings.notionSecret)
				.onChange(async (value) => {
					this.plugin.settings.notionSecret = value;
					await this.plugin.saveSettings();
					if (value) {
						new Notice('Notion secret key updated!');
					}
				}));

		new Setting(containerEl)
			.setName('Auto Sync Interval')
			.setDesc('Automatic sync interval in minutes (0 to disable)')
			.addSlider(slider => slider
				.setLimits(0, 120, 5)
				.setValue(this.plugin.settings.syncInterval)
				.setDynamicTooltip()
				.onChange(async (value) => {
					this.plugin.settings.syncInterval = value;
					await this.plugin.saveSettings();
					this.plugin.stopAutoSync();
					this.plugin.startAutoSync();
				}));

		new Setting(containerEl)
			.setName('Auto Delete Missing Pages')
			.setDesc('Automatically delete files in Obsidian when corresponding Notion pages are deleted')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.autoDeleteMissingPages)
				.onChange(async (value) => {
					this.plugin.settings.autoDeleteMissingPages = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Root Folder Path')
			.setDesc('Root folder for all synced content (leave empty for vault root)')
			.addText(text => text
				.setPlaceholder('Notion')
				.setValue(this.plugin.settings.rootFolderPath)
				.onChange(async (value) => {
					this.plugin.settings.rootFolderPath = value.trim();
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Image Folder Path')
			.setDesc('Folder path for storing downloaded images (independent of root folder, leave empty for vault root)')
			.addText(text => text
				.setPlaceholder('attachments')
				.setValue(this.plugin.settings.imageFolderPath)
				.onChange(async (value) => {
					this.plugin.settings.imageFolderPath = value.trim();
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Filtered Page IDs')
			.setDesc('Comma-separated list of Notion page/database IDs to exclude from sync')
			.addTextArea(text => text
				.setPlaceholder('page-id-1, database-id-2, page-id-3')
				.setValue(this.plugin.settings.filteredPageIds.join(', '))
				.onChange(async (value) => {
					// Parse the comma-separated list and clean up whitespace
					const pageIds = value.split(',').map(id => id.trim()).filter(id => id.length > 0);
					this.plugin.settings.filteredPageIds = pageIds;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Manual Sync')
			.setDesc('Manually sync all Notion pages')
			.addButton(button => button
				.setButtonText('Sync Now')
				.setCta()
				.onClick(async () => {
					if (!this.plugin.settings.notionSecret) {
						new Notice('Please configure Notion secret key first!');
						return;
					}
					await this.plugin.syncAllPages();
				}));

		// Show sync status
		const statusEl = containerEl.createDiv();
		const lastSync = this.plugin.settings.lastSyncTime;
		if (lastSync > 0) {
			statusEl.setText(`Last sync: ${new Date(lastSync).toLocaleString()}`);
		} else {
			statusEl.setText('Never synced');
		}

		// Show synced pages count
		const syncedCount = Object.keys(this.plugin.settings.syncedPages).length;
		const countEl = containerEl.createDiv();
		countEl.setText(`Synced pages: ${syncedCount}`);

		// Show filtered pages count
		const filteredCount = this.plugin.settings.filteredPageIds.length;
		const filteredEl = containerEl.createDiv();
		filteredEl.setText(`Filtered pages: ${filteredCount}`);
	}
}

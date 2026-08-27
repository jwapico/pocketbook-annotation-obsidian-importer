import {Notice, Plugin} from 'obsidian';
import {DEFAULT_SETTINGS, MyPluginSettings, SampleSettingTab} from "./settings";
import { readFileSync, readdirSync, statSync} from 'fs';
import * as cheerio from 'cheerio'
import crypto from "crypto"

export default class MyPlugin extends Plugin {
	settings!: MyPluginSettings;

	async onload() {
		await this.loadSettings();

		this.addCommand({
			id: "sync-pocketbook-notes",
			name: "Sync Pocketbook Notes",
			callback: () => {
				this.syncNotes();
			}
		});

		this.addSettingTab(new SampleSettingTab(this.app, this));
	}

	onunload() {
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData() as Partial<MyPluginSettings>);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	private generateHighlightHash(text: string, page: string): string {
		const input = `${text.trim()}---${page}`;
		const hash = crypto
			.createHash('sha256')
			.update(input)
			.digest('hex')
			.substring(0, 8)
			.toUpperCase();
		return hash;
	}

	private extractPersistentSection(existingContent: string): string {
		const persistStartMarker = "<!-- PERSIST START -->";
		const persistEndMarker = "<!-- PERSIST END -->";

		const startIdx = existingContent.indexOf(persistStartMarker);
		const endIdx = existingContent.indexOf(persistEndMarker);

		if (startIdx !== -1 && endIdx !== -1 && startIdx < endIdx) {
			return existingContent.substring(startIdx, endIdx + persistEndMarker.length);
		}

		return "";
	}

	private async ensureFolder(folderPath: string): Promise<void> {
		if (!this.app.vault.getAbstractFileByPath(folderPath)) {
			await this.app.vault.createFolder(folderPath);
		}
	}

	private async writeImage(src: string, imagesDir: string, noteFilename: string, index: number): Promise<string> {
		try {
			const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/.exec(src);
			if (!match) {
				console.warn("Could not parse image data URI", src.slice(0, 50));
				return "";
			}

			const mimeType = match[1]!;
			const ext = mimeType.split("/")[1] === "jpeg" ? "jpg" : mimeType.split("/")[1];
			const baseName = noteFilename.replace(/\.md$/i, "");
			const imageName = `${baseName}-${index}.${ext}`;
			const imagePath = `${imagesDir}/${imageName}`;

			const buffer = Buffer.from(match[2]!, "base64");
			const file = this.app.vault.getFileByPath(imagePath);
			if (file) {
				await this.app.vault.modify(file, buffer.toString("utf-8"));
			} else {
				const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
				await this.app.vault.createBinary(imagePath, arrayBuffer);
			}

			return `![[${imageName}]]`;
		} catch (error) {
			console.error("Failed to write image:", error);
			return "";
		}
	}

	async createPocketbookNote(filename: string, html_content: string) {
		try {
			
			const $ = cheerio.load(html_content);
			const bookTitleDiv = $("div").first();
			const authorDiv = bookTitleDiv.next();
			const creationDate = bookTitleDiv.text().trim().slice(0, 19);
			const title = bookTitleDiv.text().trim().slice(22,);
			
			let metadataContent = "";
			metadataContent += "# " + title + "\n";
			metadataContent += authorDiv.text().trim() + "\n";
			metadataContent += "Annotation Creation Date: " + creationDate + "\n";

			const imagesDir = this.settings.outputDir ? `${this.settings.outputDir}/images` : "images";
			await this.ensureFolder(imagesDir);

			const bookmarks = $("div.bookmark[id]").toArray();
			const writtenImages: string[] = [];
			const markdownEmbeds: Record<number, string> = {};
			for (const element of bookmarks) {
				const imgSrc = $(element).find("div.bm-image img").attr("src");
				if (imgSrc) {
					writtenImages.push(imgSrc);
				}
			}
			for (let i = 0; i < writtenImages.length; i++) {
				const src = writtenImages[i];
				if (src) {
					markdownEmbeds[i] = await this.writeImage(src, imagesDir, filename, i);
				}
			}

			let highlightContent = "";
			let imageIndex = 0;
			for (const element of bookmarks) {
				const $el = $(element);
				
				const page = $el.find("p.bm-page").text().trim();
				const text = $el.find("div.bm-text p").text().trim().replace(/\s+/g, " ");
				const note = $el.find("div.bm-note").text().trim();
				const hasImage = $el.find("div.bm-image img").attr("src");

				const imageEmbed = hasImage ? markdownEmbeds[imageIndex++] : "";

				if (text || imageEmbed) {
					const hash = this.generateHighlightHash(text || "Screenshot", page);
					highlightContent += `###### ${hash}\n`;
					if (text) highlightContent += "> " + text + "\n";
					if (imageEmbed) highlightContent += imageEmbed + "\n";
					if (page) highlightContent += "- Page " + page + "\n";
					if (note) highlightContent += "  - Note: " + note + "\n";
					highlightContent += "\n";
				}
			}

			if (this.settings.outputDir)
				await this.ensureFolder(this.settings.outputDir);

			const outputFilepath = (this.settings.outputDir != "") 
				? `${this.settings.outputDir}/${filename}` 
				: filename;
			
			const existingFile = this.app.vault.getFileByPath(outputFilepath);
			if (existingFile) {
				const existingContent = await this.app.vault.read(existingFile);
				const persistentContent = this.extractPersistentSection(existingContent);
				
				let formattedContent = metadataContent + "\n";
				if (persistentContent)
					formattedContent += persistentContent + "\n";
				formattedContent += highlightContent;

				await this.app.vault.modify(existingFile, formattedContent)
				new Notice(`Updated note: ${filename}`);
			} else {
				let formattedContent = metadataContent + "\n";
				formattedContent += "<!-- PERSIST START -->\n";
				formattedContent += "<!-- PERSIST END -->\n\n";
				formattedContent += highlightContent;
				await this.app.vault.create(outputFilepath, formattedContent)
				new Notice(`Created new note: ${filename}`);
			}

        } catch (error: unknown) {
			if (error instanceof Error)
	            new Notice(`Failed to create note: ${error.message}`);
    	        console.error(error);
        }
	}

	async syncNotes() {
		const statusBarItemEl = this.addStatusBarItem();
		statusBarItemEl.setText('Syncing Pocketbook Notes...');

		const files: string[] = readdirSync(this.settings.pocketbookNotesDir);

		const newestByBase = new Map<string, { file: string; mtime: number }>();
		for (const file of files) {
			const withoutExt = file.replace(/\.html$/i, "");
			const base = withoutExt.replace(/\s*\(\d+\)\s*$/i, "");
			const mtime = statSync(this.settings.pocketbookNotesDir + "/" + file).mtimeMs;
			const current = newestByBase.get(base);
			if (!current || mtime > current.mtime) {
				newestByBase.set(base, { file, mtime });
			}
		}

		const newestFiles = [...newestByBase.values()];
		for (const { file } of newestFiles) {
			statusBarItemEl.setText('Syncing Pocketbook Note: ' + file);
			const filepath = this.settings.pocketbookNotesDir + "/" + file
			const html_content = readFileSync(filepath, "utf-8");
			const filename = file.replace(/\.html$/i, "").replace(/\s*\(\d+\)\s*$/i, "") + ".md";
			this.createPocketbookNote(filename, html_content);
		}

		statusBarItemEl.setText("");
		statusBarItemEl.remove();
	}
}
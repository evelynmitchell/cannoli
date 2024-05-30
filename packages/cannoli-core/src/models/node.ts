import { CannoliObject, CannoliVertex } from "./object";
import { ChatRole, HttpRequest, HttpTemplate } from "../run";
import { CannoliEdge, ChatResponseEdge, LoggingEdge } from "./edge";
import { CannoliGroup } from "./group";
import {
	CannoliObjectStatus,
	ContentNodeType,
	EdgeType,
	GroupType,
	Reference,
	ReferenceType,
	VaultModifier,
	VerifiedCannoliCanvasData,
	VerifiedCannoliCanvasFileData,
	VerifiedCannoliCanvasLinkData,
	VerifiedCannoliCanvasTextData,
} from "./graph";
import * as yaml from "js-yaml";
import {
	GenericCompletionParams,
	GenericCompletionResponse,
	GenericFunctionCall,
	GenericModelConfig,
	SupportedProviders,
} from "../providers";
import invariant from "tiny-invariant";
import { pathOr, stringToPath } from "remeda";

type VariableValue = { name: string; content: string; edgeId: string | null };

type VersionedContent = {
	content: string;
	versionArray: {
		version: number;
		header: string | null;
		subHeader: string | null;
	}[];
};

type TreeNode = {
	header: string | null;
	subHeader: string | null;
	content?: string;
	children?: TreeNode[];
};

export class CannoliNode extends CannoliVertex {
	references: Reference[] = [];
	renderFunction: (
		variables: { name: string; content: string }[]
	) => Promise<string>;

	constructor(
		nodeData:
			| VerifiedCannoliCanvasFileData
			| VerifiedCannoliCanvasLinkData
			| VerifiedCannoliCanvasTextData,
		fullCanvasData: VerifiedCannoliCanvasData
	) {
		super(nodeData, fullCanvasData);
		this.references = nodeData.cannoliData.references || [];
		this.renderFunction = this.buildRenderFunction();
	}

	buildRenderFunction() {
		// Replace references with placeholders using an index-based system
		let textCopy = this.text.slice();

		let index = 0;
		// Updated regex pattern to avoid matching newlines inside the double braces
		textCopy = textCopy.replace(/\{\{[^{}\n]+\}\}/g, () => `{{${index++}}}`);

		// Define and return the render function
		const renderFunction = async (
			variables: { name: string; content: string }[]
		) => {
			// Process embedded notes
			let processedText = await this.processEmbeds(textCopy);

			// Create a map to look up variable content by name
			const varMap = new Map(variables.map((v) => [v.name, v.content]));
			// Replace the indexed placeholders with the content from the variables
			processedText = processedText.replace(/\{\{(\d+)\}\}/g, (match, index) => {
				// Retrieve the reference by index
				const reference = this.references[Number(index)];
				// Retrieve the content from the varMap using the reference's name
				return varMap.get(reference.name) ?? "{{invalid}}";
			});

			// Only replace dataview queries and smart connections if there's a fileSystemInterface
			if (this.run.fileSystemInterface) {
				// Render dataview queries
				processedText = await this.run.fileSystemInterface.replaceDataviewQueries(processedText, this.run.isMock);

				// Render smart connections
				processedText = await this.run.fileSystemInterface.replaceSmartConnections(
					processedText,
					this.run.isMock
				);
			}

			return processedText;
		};


		return renderFunction;
	}


	async processEmbeds(content: string): Promise<string> {
		// Check for embedded notes (e.g. ![[Note Name]]), and replace them with the note content
		const embeddedNotes = content.match(/!\[\[[\s\S]*?\]\]/g);

		if (embeddedNotes) {
			for (const embeddedNote of embeddedNotes) {
				let noteName = embeddedNote
					.replace("![[", "")
					.replace("]]", "");

				let subpath;

				// If there's a pipe, split and use the first part as the note name
				if (noteName.includes("|")) {
					noteName = noteName.split("|")[0];
				}

				// If there's a "#", split and use the first part as the note name, and the second part as the heading
				if (noteName.includes("#")) {
					const split = noteName.split("#");
					noteName = split[0];
					subpath = split[1];
				}

				// If there's no fileSystemInterface, throw an error
				if (!this.run.fileSystemInterface) {
					throw new Error("No fileSystemInterface found");
				}

				const noteContent = await this.run.fileSystemInterface.getNote({
					name: noteName,
					type: ReferenceType.Note,
					shouldExtract: true,
					includeName: true,
					subpath: subpath,
				}, this.run.isMock);



				if (noteContent) {
					const blockquotedNoteContent =
						"> " + noteContent.replace(/\n/g, "\n> ");
					content = content.replace(
						embeddedNote,
						blockquotedNoteContent
					);
				}
			}
		}

		return content;
	}

	async getContentFromNote(reference: Reference): Promise<string | null> {
		// If there's no fileSystemInterface, throw an error
		if (!this.run.fileSystemInterface) {
			throw new Error("No fileSystemInterface found");
		}

		const note = await this.run.fileSystemInterface.getNote(reference, this.run.isMock);

		if (note === null) {
			return null;
		}

		return note;
	}

	getContentFromFloatingNode(name: string): string | null {
		for (const object of Object.values(this.graph)) {
			if (object instanceof FloatingNode && object.getName() === name) {
				return object.getContent();
			}
		}
		return null;
	}

	async processReferences(additionalVariableValues?: VariableValue[], cleanForJson?: boolean) {
		const variableValues = this.getVariableValues(true);

		if (additionalVariableValues) {
			variableValues.push(...additionalVariableValues);
		}

		const resolvedReferences = await Promise.all(
			this.references.map(async (reference) => {
				let content = "{{invalid reference}}";
				const { name } = reference;

				if (
					(reference.type === ReferenceType.Variable ||
						reference.type === ReferenceType.Selection) &&
					!reference.shouldExtract
				) {
					// First, try to get the content from variable values
					const variable = variableValues.find(
						(variable: { name: string }) =>
							variable.name === reference.name
					);

					if (variable) {
						content = variable.content;
					} else {
						// If variable content is null, fall back to floating node
						const floatingContent = this.getContentFromFloatingNode(reference.name);
						if (floatingContent !== null) {
							content = floatingContent;
						}
						// If the reference name contains only "#" symbols, replace it with the loop index
						else if (reference.name.match(/^#+$/)) {
							// Depth is the number of hash symbols minus 1
							const depth = reference.name.length - 1;
							const loopIndex = this.getLoopIndex(depth);
							if (loopIndex !== null) {
								content = loopIndex.toString();
							} else {
								content = `{{${reference.name}}}`;
							}
						} else {
							// this.warning(`Variable "${reference.name}" not found`);
							content = `{{${reference.name}}}`;
						}
					}
				} else if (
					(reference.type === ReferenceType.Variable ||
						reference.type === ReferenceType.Selection) &&
					reference.shouldExtract
				) {
					// First, try to get the content from variable values
					const variable = variableValues.find(
						(variable) => variable.name === reference.name
					);
					if (variable && variable.content) {
						content = variable.content;
					} else {
						// If variable content is null, fall back to floating node
						const floatingContent = this.getContentFromFloatingNode(reference.name);
						if (floatingContent !== null) {
							content = floatingContent;
						}
					}

					if (content !== "{{invalid reference}}") {
						// Save original variable name
						const originalName = reference.name;

						// Set reference name to the content of the variable
						reference.name = content;

						// Get the content from the note
						const noteContent = await this.getContentFromNote(
							reference
						);

						// Restore original variable name
						reference.name = originalName;
						if (noteContent !== null) {
							content = noteContent;
						} else {
							this.warning(
								`Note "${content}" not found`
							);
							content = `{{@${reference.name}}}`;
						}
					} else {
						//this.warning(`Variable "${reference.name}" not found`);
						content = `{{@${reference.name}}}`;
					}
				} else if (reference.type === ReferenceType.Note) {
					if (reference.shouldExtract) {
						const noteContent = await this.getContentFromNote(
							reference
						);
						if (noteContent !== null) {
							content = noteContent;
						} else {
							this.warning(`Note "${reference.name}" not found`);
							content = `{{[[${reference.name}]]}}`;
						}
					} else {
						content = reference.name;
					}
				} else if (reference.type === ReferenceType.Floating) {
					if (reference.shouldExtract) {
						const floatingContent = this.getContentFromFloatingNode(
							reference.name
						);
						if (floatingContent !== null) {
							content = floatingContent;
						} else {
							this.warning(`Floating node "${name}" not found`);
							content = `{{[${reference.name}]}}`;
						}
					}
				}

				if (cleanForJson) {
					content = content.replace(/\\/g, '\\\\')
						.replace(/\n/g, "\\n")
						.replace(/"/g, '\\"')
						.replace(/\t/g, '\\t');
				}

				return { name, content };
			})
		);

		return this.renderFunction(resolvedReferences);
	}

	getLoopIndex(depth: number): number | null {
		// Get the group at the specified depth (0 is the most immediate group)
		const group = this.graph[this.groups[depth]];

		// If group is not there, return null
		if (!group) {
			return null;
		}

		// If group is not a CannoliGroup, return null
		if (!(group instanceof CannoliGroup)) {
			return null;
		}

		// If the group is not a repeat or forEach group, return null
		if (
			group.type !== GroupType.Repeat &&
			group.type !== GroupType.ForEach
		) {
			return null;
		}

		// Get the loop index from the group
		const loopIndex = group.currentLoop + 1;

		return loopIndex;
	}

	getVariableValues(includeGroupEdges: boolean): VariableValue[] {
		const variableValues: VariableValue[] = [];

		// Get all available provide edges
		let availableEdges = this.getAllAvailableProvideEdges();

		// If includeGroupEdges is not true, filter for only incoming edges of this node
		if (!includeGroupEdges) {
			availableEdges = availableEdges.filter((edge) =>
				this.incomingEdges.includes(edge.id)
			);
		}

		for (const edge of availableEdges) {
			const edgeObject = this.graph[edge.id];
			if (!(edgeObject instanceof CannoliEdge)) {
				throw new Error(
					`Error on object ${edgeObject.id}: object is not a provide edge.`
				);
			}

			// If the edge isn't complete, check its status
			if (!(edgeObject.status === CannoliObjectStatus.Complete)) {
				// If the edge is reflexive and not rejected, set its content to an empty string and keep going
				if (edgeObject.isReflexive && edgeObject.status !== CannoliObjectStatus.Rejected) {
					edgeObject.content = "";
				} else if (
					// If the edge is not rejected, not reflexive, or its content is null, skip it
					!(edgeObject.status === CannoliObjectStatus.Rejected) ||
					!edgeObject.isReflexive ||
					edgeObject.content === null
				) {
					continue;
				}
			}

			let content: string;

			if (edgeObject.content === null) {
				continue;
			}

			if (typeof edgeObject.content === "string" && edgeObject.text) {
				// if the edge has a versions array
				if (edgeObject.versions && edgeObject.versions.length > 0) {
					const allVersions: VersionedContent[] = [{
						content: edgeObject.content,
						versionArray: edgeObject.versions.map((version) => ({
							version: version.version,
							header: version.header,
							subHeader: version.subHeader
						}))
					}];

					// Find all edges with the same name and add them to the allVersions array
					const edgesWithSameName = this.getAllAvailableProvideEdges().filter((edge) => edge.text === edgeObject.text);
					for (const otherVersion of edgesWithSameName) {

						if (otherVersion.id !== edgeObject.id &&
							otherVersion.versions?.length === edgeObject.versions?.length &&
							otherVersion.content !== null) {
							allVersions.push(
								{
									content: otherVersion.content as string,
									versionArray: otherVersion.versions
								}
							)
						}
					}

					content = this.renderAsMarkdownDocument(this.transformToTree(allVersions));
				} else {
					content = edgeObject.content;
				}

				const variableValue = {
					name: edgeObject.text,
					content: content,
					edgeId: edgeObject.id,
				};

				variableValues.push(variableValue);
			} else if (
				typeof edgeObject.content === "object" &&
				!Array.isArray(edgeObject.content)
			) {
				const multipleVariableValues = [];

				for (const name in edgeObject.content) {
					const variableValue = {
						name: name,
						content: edgeObject.content[name],
						edgeId: edgeObject.id,
					};

					multipleVariableValues.push(variableValue);
				}

				variableValues.push(...multipleVariableValues);
			} else {
				continue;
			}
		}

		// Add the default "NOTE" variable
		if (this.run.currentNote && includeGroupEdges) {
			const currentNoteVariableValue = {
				name: "NOTE",
				content: this.run.currentNote,
				edgeId: "",
			};

			variableValues.push(currentNoteVariableValue);
		}

		// Add the default "SELECTION" variable
		if (this.run.selection && includeGroupEdges) {
			const currentSelectionVariableValue = {
				name: "SELECTION",
				content: this.run.selection,
				edgeId: "",
			};

			variableValues.push(currentSelectionVariableValue);
		}

		// Resolve variable conflicts
		const resolvedVariableValues =
			this.resolveVariableConflicts(variableValues);

		return resolvedVariableValues;
	}

	transformToTree(allVersions: VersionedContent[]): TreeNode {
		const root: TreeNode = { header: null, subHeader: null, children: [] };

		allVersions.forEach(item => {
			let currentNode = root;

			for (let i = item.versionArray.length - 1; i >= 0; i--) {
				const version = item.versionArray[i];
				if (!currentNode.children) {
					currentNode.children = [];
				}

				let nextNode = currentNode.children.find(child => child.subHeader === version.subHeader);

				if (!nextNode) {
					nextNode = {
						header: version.header,
						subHeader: version.subHeader,
						children: []
					};
					currentNode.children.push(nextNode);
				}

				currentNode = nextNode;

				if (i === 0) {
					currentNode.content = item.content;
				}
			}
		});

		return root;
	}

	renderAsMarkdownDocument(tree: TreeNode, level: number = 1): string {
		let result = '';

		if (tree.subHeader) {
			result += `${'#'.repeat(level)} ${tree.subHeader}\n\n`;
		}

		if (tree.content) {
			result += `${tree.content}\n\n`;
		}

		if (tree.children) {
			tree.children.forEach(child => {
				result += this.renderAsMarkdownDocument(child, level + 1);
			});
		}

		return result;
	}

	renderAsMarkdownList(tree: TreeNode, indent: string = ''): string {
		let result = '';

		if (tree.subHeader) {
			result += `${indent}- ${tree.subHeader}\n`;
		}

		if (tree.content) {
			result += `${indent}  ${tree.content}\n`;
		}

		if (tree.children) {
			tree.children.forEach(child => {
				result += this.renderAsMarkdownList(child, indent + '  ');
			});
		}

		return result;
	}

	renderAsMarkdownTable(tree: TreeNode): string {
		let table = '';

		if (!tree.children) {
			return table;
		}

		// Extract the headers from the first child
		const headers = tree.children.map(child => child.subHeader);

		// Create the table header with an empty cell for the main header
		table += '| |' + headers.join(' | ') + ' |\n';
		table += '| --- |' + headers.map(() => ' --- ').join(' | ') + ' |\n';

		// Create the table rows
		tree.children[0].children!.forEach((subChild, index) => {
			table += '| ' + subChild.subHeader + ' |';
			tree.children?.forEach(child => {
				const content = child.children![index].content ?? '';
				table += ` ${content} |`;
			});
			table += '\n';
		});

		return table;
	}

	resolveVariableConflicts(variableValues: VariableValue[]): VariableValue[] {
		const finalVariables: VariableValue[] = [];
		const groupedByName: Record<string, VariableValue[]> = {};

		// Group the variable values by name
		for (const variable of variableValues) {
			if (!groupedByName[variable.name]) {
				groupedByName[variable.name] = [];
			}
			groupedByName[variable.name].push(variable);
		}

		// Iterate through the grouped names
		for (const name in groupedByName) {
			// Get all the variable values for this name
			const variables = groupedByName[name];

			let selectedVariable = variables[0]; // Start with the first variable
			let foundNonEmptyReflexive = false;

			// Iterate through the variables, preferring the reflexive edge if found
			for (const variable of variables) {
				if (!variable.edgeId) {
					// If the variable has no edgeId, it's a special variable given by the node, it always has priority
					selectedVariable = variable;
					break;
				}

				const edgeObject = this.graph[variable.edgeId];

				// Check if edgeObject is an instance of CannoliEdge and if it's reflexive
				if (
					edgeObject instanceof CannoliEdge &&
					edgeObject.isReflexive
				) {
					if (edgeObject.content !== "") {
						selectedVariable = variable;
						foundNonEmptyReflexive = true;
						break; // Exit the loop once a reflexive edge with non-empty content is found
					} else if (!foundNonEmptyReflexive) {
						// If no non-empty reflexive edge has been found yet, prefer the first reflexive edge
						selectedVariable = variable;
					}
				}
			}

			// If no non-empty reflexive edge was found, prefer the first non-reflexive edge
			if (!foundNonEmptyReflexive && selectedVariable.content === "") {
				for (const variable of variables) {
					if (!variable.edgeId) {
						this.error(`Variable ${name} has no edgeId`);
						continue;
					}

					const edgeObject = this.graph[variable.edgeId];
					if (
						!(edgeObject instanceof CannoliEdge) ||
						!edgeObject.isReflexive
					) {
						selectedVariable = variable;
						break;
					}
				}
			}

			// Add the selected variable to the final array
			finalVariables.push(selectedVariable);
		}

		return finalVariables;
	}

	loadOutgoingEdges(content: string, request?: GenericCompletionParams) {
		let itemIndex = 0;
		let listItems: string[] = [];

		if (this.type === ContentNodeType.Http && this.outgoingEdges.some(edge => this.graph[edge].type === EdgeType.Item)) {
			// Parse the text of the edge with remeda
			const path = stringToPath(this.graph[this.outgoingEdges.find(edge => this.graph[edge].type === EdgeType.Item)!].text);

			let contentObject;

			// Try to parse the content as JSON
			try {
				contentObject = JSON.parse(content as string);
			} catch (e) {
				// If parsing fails, continue with markdown list parsing
			}

			// If we parsed the content as JSON, use the parsed object
			if (contentObject) {
				// Get the value from the parsed text
				const value = pathOr(contentObject, path, content);
				listItems = this.getListArrayFromContent(JSON.stringify(value, null, 2));
			} else {
				// If we didn't parse the content as JSON, use the original content
				listItems = this.getListArrayFromContent(content);
			}
		} else {
			listItems = this.getListArrayFromContent(content);
		}

		for (const edge of this.outgoingEdges) {
			const edgeObject = this.graph[edge];
			let contentToLoad = content;

			// If it's coming from an httpnode
			if (this.type === ContentNodeType.Http) {
				// Parse the text of the edge with remeda
				const path = stringToPath(edgeObject.text);

				let contentObject;

				// Try to parse the content as JSON
				try {
					contentObject = JSON.parse(content as string);
				} catch (e) {
					// If parsing fails, continue with markdown list parsing
				}

				// If we parsed the content as JSON, use the parsed object
				if (contentObject) {

					// Get the value from the parsed text
					const value = pathOr(contentObject, path, content);

					// If the value is a string, just set content to it
					if (typeof value === "string") {
						contentToLoad = value;
					} else {
						contentToLoad = JSON.stringify(value, null, 2);
					}
				} else {
					// If we didn't parse the content as JSON, use the original content
					contentToLoad = content;
				}


			}


			if (edgeObject instanceof CannoliEdge && !(edgeObject instanceof ChatResponseEdge) && edgeObject.type !== EdgeType.Item) {
				edgeObject.load({
					content: contentToLoad,
					request: request,
				});
			} else if (edgeObject instanceof CannoliEdge && edgeObject.type === EdgeType.Item) {
				const item = listItems[itemIndex];

				// If we exceed the list items, reject the edge
				if (!item) {
					edgeObject.reject();
					continue;
				}

				edgeObject.load({
					content: item,
					request: request,
				});
				itemIndex++;
			}
		}
	}

	getListArrayFromContent(content: string): string[] {
		// Attempt to parse the content as JSON
		try {
			const jsonArray = JSON.parse(content);
			if (Array.isArray(jsonArray)) {
				return jsonArray.map(item => typeof item === 'string' ? item : JSON.stringify(item));
			}
		} catch (e) {
			// If parsing fails, continue with markdown list parsing
		}

		// First pass: look for markdown list items, and return the item at the index
		const lines = content.split("\n");

		// Filter out the lines that don't start with "- " or a number followed by ". "
		const listItems = lines.filter((line) => line.startsWith("- ") || /^\d+\. /.test(line));

		// Return the list items without the "- " or the number and ". "
		return listItems.map((item) => item.startsWith("- ") ? item.substring(2) : item.replace(/^\d+\. /, ""));
	}

	dependencyCompleted(dependency: CannoliObject): void {
		if (
			this.allDependenciesComplete() &&
			this.status === CannoliObjectStatus.Pending
		) {
			this.execute();
		}
	}

	getNoteOrFloatingReference(): Reference | null {
		const notePattern = /^{{\[\[([^\]]+)\]\]([\W]*)}}$/;
		const floatingPattern = /^{{\[([^\]]+)\]}}$/;
		const currentNotePattern = /^{{NOTE([\W]*)}}$/;

		const strippedText = this.text.trim();

		let match = notePattern.exec(strippedText);
		if (match) {
			const reference: Reference = {
				name: match[1],
				type: ReferenceType.Note,
				shouldExtract: false,
			};

			const modifiers = match[2];
			if (modifiers) {
				if (modifiers.includes("!#")) {
					reference.includeName = false;
				} else if (modifiers.includes("#")) {
					reference.includeName = true;
				}

				if (modifiers.includes("!$")) {
					reference.includeProperties = false;
				} else if (modifiers.includes("$")) {
					reference.includeProperties = true;
				}

				if (modifiers.includes("!@")) {
					reference.includeLink = false;
				} else if (modifiers.includes("@")) {
					reference.includeLink = true;
				}
			}
			return reference;
		}

		match = floatingPattern.exec(strippedText);
		if (match) {
			const reference = {
				name: match[1],
				type: ReferenceType.Floating,
				shouldExtract: false,
			};
			return reference;
		}

		match = currentNotePattern.exec(strippedText);
		if (match && this.run.currentNote) {
			const reference: Reference = {
				name: this.run.currentNote,
				type: ReferenceType.Note,
				shouldExtract: false,
			};

			const modifiers = match[1];
			if (modifiers) {
				if (modifiers.includes("!#")) {
					reference.includeName = false;
				} else if (modifiers.includes("#")) {
					reference.includeName = true;
				}

				if (modifiers.includes("!$")) {
					reference.includeProperties = false;
				} else if (modifiers.includes("$")) {
					reference.includeProperties = true;
				}

				if (modifiers.includes("!@")) {
					reference.includeLink = false;
				} else if (modifiers.includes("@")) {
					reference.includeLink = true;
				}
			}
			return reference;
		}

		return null;
	}

	logDetails(): string {
		let groupsString = "";
		groupsString += `Groups: `;
		for (const group of this.groups) {
			groupsString += `\n\t-"${this.ensureStringLength(
				this.graph[group].text,
				15
			)}"`;
		}

		let incomingEdgesString = "";
		incomingEdgesString += `Incoming Edges: `;
		for (const edge of this.incomingEdges) {
			incomingEdgesString += `\n\t-"${this.ensureStringLength(
				this.graph[edge].text,
				15
			)}"`;
		}

		let outgoingEdgesString = "";
		outgoingEdgesString += `Outgoing Edges: `;
		for (const edge of this.outgoingEdges) {
			outgoingEdgesString += `\n\t-"${this.ensureStringLength(
				this.graph[edge].text,
				15
			)}"`;
		}

		return (
			`[] Node ${this.id} Text: "${this.text}"\n${incomingEdgesString}\n${outgoingEdgesString}\n${groupsString}\n` +
			super.logDetails()
		);
	}

	validate(): void {
		super.validate();

		// Nodes can't have any incoming list edges
		if (this.incomingEdges.filter((edge) => this.graph[edge].type === EdgeType.List).length > 0) {
			this.error(`Nodes can't have any incoming list edges.`);
		}
	}

	getSpecialOutgoingEdges(): CannoliEdge[] {
		// Get all special outgoing edges
		const specialOutgoingEdges = this.getOutgoingEdges().filter((edge) => {
			return (
				edge.type === EdgeType.Field ||
				edge.type === EdgeType.Choice ||
				// edge.type === EdgeType.Merge ||
				edge.type === EdgeType.List ||
				edge.type === EdgeType.Variable
			);
		});

		return specialOutgoingEdges;
	}

	specialOutgoingEdgesAreHomogeneous(): boolean {
		const specialOutgoingEdges = this.getSpecialOutgoingEdges();

		if (specialOutgoingEdges.length === 0) {
			return true;
		}

		const firstEdgeType = specialOutgoingEdges[0].type;

		for (const edge of specialOutgoingEdges) {
			if (edge.type !== firstEdgeType) {
				return false;
			}
		}

		return true;
	}

	getAllAvailableProvideEdges(): CannoliEdge[] {
		const availableEdges: CannoliEdge[] = [];

		// Get the incoming edges of all groups
		for (const group of this.groups) {
			const groupObject = this.graph[group];
			if (!(groupObject instanceof CannoliVertex)) {
				throw new Error(
					`Error on node ${this.id}: group is not a vertex.`
				);
			}

			const groupIncomingEdges = groupObject.getIncomingEdges();

			availableEdges.push(...groupIncomingEdges);
		}

		// Get the incoming edges of this node
		const nodeIncomingEdges = this.getIncomingEdges();

		availableEdges.push(...nodeIncomingEdges);

		// Filter out all logging, and write edges
		const filteredEdges = availableEdges.filter(
			(edge) =>
				edge.type !== EdgeType.Logging &&
				edge.type !== EdgeType.Write &&
				edge.type !== EdgeType.Config
		);

		return filteredEdges as CannoliEdge[];
	}
}

export class CallNode extends CannoliNode {
	getPrependedMessages(): GenericCompletionResponse[] {
		const messages: GenericCompletionResponse[] = [];

		// Get all available provide edges
		const availableEdges = this.getAllAvailableProvideEdges();

		// filter for only incoming edges of this node
		const directEdges = availableEdges.filter((edge) =>
			this.incomingEdges.includes(edge.id)
		);

		// Filter for indirect edges (not incoming edges of this node)
		const indirectEdges = availableEdges.filter(
			(edge) => !this.incomingEdges.includes(edge.id)
		);

		for (const edge of directEdges) {
			const edgeObject = this.graph[edge.id];
			if (!(edgeObject instanceof CannoliEdge)) {
				throw new Error(
					`Error on object ${edgeObject.id}: object is not a provide edge.`
				);
			}

			const edgeMessages = edgeObject.messages;

			// console.log(
			// 	`Edge messages: ${JSON.stringify(edgeMessages, null, 2)}`
			// );

			if (!edgeMessages) {
				continue;
			}

			if (edgeMessages.length < 1) {
				continue;
			}

			// If the edge is crossing a group, check if there are any indirect edges pointing to that group
			for (const group of edgeObject.crossingInGroups) {
				const indirectEdgesToGroup = indirectEdges.filter(
					(edge) => edge.target === group
				);

				// Filter for those indirect edges that have addMessages = true
				const indirectEdgesToAdd = indirectEdgesToGroup.filter(
					(edge) =>
						this.graph[edge.id] instanceof CannoliEdge &&
						(this.graph[edge.id] as CannoliEdge).addMessages
				);

				// For each indirect edge
				for (const indirectEdge of indirectEdgesToAdd) {
					const indirectEdgeObject = this.graph[indirectEdge.id];
					if (!(indirectEdgeObject instanceof CannoliEdge)) {
						throw new Error(
							`Error on object ${indirectEdgeObject.id}: object is not a provide edge.`
						);
					}

					const indirectEdgeMessages = indirectEdgeObject.messages;

					if (!indirectEdgeMessages) {
						continue;
					}

					if (indirectEdgeMessages.length < 1) {
						continue;
					}

					// Overwrite edgeMessages with indirectEdgeMessages
					edgeMessages.length = 0;
					edgeMessages.push(...indirectEdgeMessages);
				}
			}

			if (edgeMessages) {
				// If its a system message, add it to the beginning of the array
				if (edge.type === EdgeType.SystemMessage) {
					messages.unshift(edgeMessages[0]);
				} else {
					messages.push(...edgeMessages);
				}
			}
		}

		// If messages is empty and there are no incoming edges with addMessages = true, try it with indirect edges
		if (
			messages.length === 0 &&
			this.incomingEdges.filter(
				(edge) =>
					this.cannoliGraph.isEdge(this.graph[edge]) &&
					(this.graph[edge] as CannoliEdge).addMessages
			).length === 0
		) {
			for (const edge of indirectEdges) {
				const edgeObject = this.graph[edge.id];
				if (!(edgeObject instanceof CannoliEdge)) {
					throw new Error(
						`Error on object ${edgeObject.id}: object is not a provide edge.`
					);
				}

				const edgeMessages = edgeObject.messages;

				if (!edgeMessages) {
					continue;
				}

				if (edgeMessages.length < 1) {
					continue;
				}

				if (edgeMessages) {
					// If its a system message, add it to the beginning of the array
					if (edge.type === EdgeType.SystemMessage) {
						messages.unshift(edgeMessages[0]);
					} else {
						messages.push(...edgeMessages);
					}
				}
			}
		}

		return messages;
	}

	async getNewMessage(
		role?: string
	): Promise<GenericCompletionResponse | null> {
		const content = await this.processReferences();

		// If there is no content, return null
		if (!content) {
			return null;
		}

		return {
			role: (role as ChatRole) || "user",
			content: content,
		};
	}

	findNoteReferencesInMessages(
		messages: GenericCompletionResponse[]
	): string[] {
		const references: string[] = [];
		const noteRegex = /\[\[(.+?)\]\]/g;

		// Get the contents of each double bracket
		for (const message of messages) {
			const matches =
				typeof message.content === "string" &&
				message.content?.matchAll(noteRegex);

			if (!matches) {
				continue;
			}

			for (const match of matches) {
				references.push(match[1]);
			}
		}

		return references;
	}

	private updateConfigWithValue(
		runConfig: GenericModelConfig,
		content: string | Record<string, string> | null,
		setting?: string | null
	): void {
		const sampleConfig = this.run.llm?.getSampleConfig() ?? {};

		// Define the expected types for each key
		const keyTypeMap: {
			[key in keyof GenericModelConfig]?: "string" | "number";
		} = {
			frequency_penalty: "number",
			presence_penalty: "number",
			temperature: "number",
			top_p: "number",
		};

		// Convert value based on its expected type
		const convertValue = (key: keyof GenericModelConfig, value: string) => {
			const expectedType = keyTypeMap[key];
			return expectedType === "number" ? parseFloat(value) : value;
		};

		// Type guard to check if a string is a key of LLMConfig
		const isValidKey = (key: string): key is keyof GenericModelConfig => {
			return key in sampleConfig;
		};

		if (typeof content === "string") {
			if (setting && isValidKey(setting)) {
				// Use isValidKey
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				(runConfig as any)[setting] = convertValue(setting, content); // Using type assertion with conversion
			} else {
				this.error(`"${setting}" is not a valid config setting.`);
			}
		} else if (typeof content === "object") {
			for (const key in content) {
				if (isValidKey(key)) {
					// Use isValidKey
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
					(runConfig as any)[key] = convertValue(key, content[key]); // Using type assertion with conversion
				} else {
					this.error(`"${key}" is not a valid config setting.`);
				}
			}
		}
	}

	private processSingleEdge(
		runConfig: GenericModelConfig,
		edgeObject: CannoliEdge
	): void {
		if (
			typeof edgeObject.content === "string" ||
			typeof edgeObject.content === "object"
		) {
			this.updateConfigWithValue(
				runConfig,
				edgeObject.content,
				edgeObject.text
			);
		} else {
			this.error(`Config edge has invalid content.`);
		}
	}

	private processEdges(
		runConfig: GenericModelConfig,
		edges: CannoliEdge[]
	): void {
		for (const edgeObject of edges) {
			if (!(edgeObject instanceof CannoliEdge)) {
				throw new Error(
					`Error processing config edges: object is not an edge.`
				);
			}
			this.processSingleEdge(runConfig, edgeObject);
		}
	}

	private processGroups(runConfig: GenericModelConfig): void {
		for (let i = this.groups.length - 1; i >= 0; i--) {
			const group = this.graph[this.groups[i]];
			if (group instanceof CannoliGroup) {
				const configEdges = group
					.getIncomingEdges()
					.filter((edge) => edge.type === EdgeType.Config);
				this.processEdges(runConfig, configEdges);
			}
		}
	}

	private processNodes(runConfig: GenericModelConfig): void {
		const configEdges = this.getIncomingEdges().filter(
			(edge) => edge.type === EdgeType.Config
		);
		this.processEdges(runConfig, configEdges);
	}

	getConfig(): GenericModelConfig {
		const runConfig = {};

		this.processGroups(runConfig);
		this.processNodes(runConfig);

		return runConfig;
	}

	async execute() {
		this.executing();

		const request = await this.createLLMRequest();

		// If the message array is empty, error
		if (request.messages.length === 0) {
			this.error(
				`No messages to send to LLM. Empty call nodes only send the message history they've been passed.`
			);
			return;
		}

		// If the node has an outgoing chatResponse edge, call with streaming
		const chatResponseEdges = this.getOutgoingEdges().filter(
			(edge) => edge.type === EdgeType.ChatResponse
		);

		if (chatResponseEdges.length > 0) {
			const stream = await this.run.callLLMStream(request);

			if (stream instanceof Error) {
				this.error(`Error calling LLM:\n${stream.message}`);
				return;
			}

			if (!stream) {
				this.error(`Error calling LLM: no stream returned.`);
				return;
			}

			if (typeof stream === "string") {
				this.loadOutgoingEdges(stream, request);
				this.completed();
				return;
			}

			// Create message content string
			let messageContent = "";
			// Process the stream. For each part, add the message to the request, and load the outgoing edges
			for await (const part of stream) {
				if (!part || typeof part !== "string") {
					// deltas might be empty, that's okay, just get the next one
					continue;
				}

				// Add the part to the message content
				messageContent += part;

				// Load outgoing chatResponse edges with the part
				for (const edge of chatResponseEdges) {
					edge.load({
						content: part ?? "",
						request: request,
					});
				}
			}

			// Load outgoing chatResponse edges with the message "END OF STREAM"
			for (const edge of chatResponseEdges) {
				edge.load({
					content: "END OF STREAM",
					request: request,
				});
			}

			// Add an assistant message to the messages array of the request
			request.messages.push({
				role: "assistant",
				content: messageContent,
			});

			// After the stream is done, load the outgoing edges
			this.loadOutgoingEdges(messageContent, request);
		} else {
			const message = await this.run.callLLM(request);

			if (message instanceof Error) {
				this.error(`Error calling LLM:\n${message.message}`);
				return;
			}

			if (!message) {
				this.error(`Error calling LLM: no message returned.`);
				return;
			}

			request.messages.push(message);

			if (message.function_call?.arguments) {
				if (message.function_call.name === "note_select") {
					const args = JSON.parse(message.function_call.arguments);

					// Put double brackets around the note name
					args.note = `[[${args.note}]]`;

					this.loadOutgoingEdges(args.note, request);
				} else {
					this.loadOutgoingEdges(message.content ?? "", request);
				}
			} else {
				this.loadOutgoingEdges(message.content ?? "", request);
			}
		}

		this.completed();
	}

	async createLLMRequest(): Promise<GenericCompletionParams> {
		const overrides = this.getConfig();
		const config = this.run.llm?.getMergedConfig({
			configOverrides: overrides,
			provider: (overrides.provider as SupportedProviders) ?? undefined
		});
		invariant(config, "Config is undefined");

		const messages = this.getPrependedMessages();

		const newMessage = await this.getNewMessage(config.role);

		// Remove the role from the config
		delete config.role;

		if (newMessage) {
			messages.push(newMessage);
		}

		const functions = this.getFunctions(messages);

		const function_call =
			functions && functions.length > 0
				? { name: functions[0].name }
				: undefined;

		return {
			messages: messages,
			...config,
			functions:
				functions && functions.length > 0 ? functions : undefined,
			function_call: function_call ? function_call : undefined,
		};
	}

	getFunctions(messages: GenericCompletionResponse[]): GenericFunctionCall[] {
		if (
			this.getOutgoingEdges().some(
				(edge) => edge.vaultModifier === VaultModifier.Note
			)
		) {
			const noteNames = this.findNoteReferencesInMessages(messages);
			return [this.run.createNoteNameFunction(noteNames)];
		} else {
			return [];
		}
	}

	logDetails(): string {
		return super.logDetails() + `Type: Call\n`;
	}

	validate() {
		super.validate();
	}
}

export class FormNode extends CallNode {
	getFunctions(
		messages: GenericCompletionResponse[]
	): GenericFunctionCall[] {
		// Get the names of the fields
		const fields = this.getFields();

		const fieldsWithNotes: { name: string; noteNames?: string[] }[] = [];

		// If one of the outgoing edges has a vault modifier of type "note", get the note names and pass it into that field
		const noteEdges = this.getOutgoingEdges().filter(
			(edge) => edge.vaultModifier === VaultModifier.Note
		);

		for (const item of fields) {
			// If the item matches the name of one of the note edges
			if (noteEdges.find((edge) => edge.text === item)) {
				// Get the note names
				const noteNames = this.findNoteReferencesInMessages(messages);

				fieldsWithNotes.push({ name: item, noteNames: noteNames });
			} else {
				fieldsWithNotes.push({ name: item });
			}
		}

		// Generate the form function
		const formFunc = this.run.createFormFunction(fieldsWithNotes);

		return [formFunc];
	}

	getFields(): string[] {
		// Get the unique names of all outgoing field edges
		const outgoingFieldEdges = this.getOutgoingEdges().filter((edge) => {
			return edge.type === EdgeType.Field;
		});

		const uniqueNames = new Set<string>();

		for (const edge of outgoingFieldEdges) {
			const edgeObject = this.graph[edge.id];
			if (!(edgeObject instanceof CannoliEdge)) {
				throw new Error(
					`Error on object ${edgeObject.id}: object is not a field edge.`
				);
			}

			const name = edgeObject.text;

			if (name) {
				uniqueNames.add(name);
			}
		}

		return Array.from(uniqueNames);
	}

	loadOutgoingEdges(content: string, request: GenericCompletionParams): void {
		const messages = request.messages;

		// Get the fields from the last message
		const lastMessage = messages[messages.length - 1];
		const formFunctionArgs =
			"function_call" in lastMessage &&
			lastMessage.function_call?.arguments;

		if (!formFunctionArgs) {
			this.error(`Form function call has no arguments.`);
			return;
		}

		// Parse the fields from the arguments
		const fields = JSON.parse(formFunctionArgs);

		for (const edge of this.outgoingEdges) {
			const edgeObject = this.graph[edge];
			if (edgeObject instanceof CannoliEdge) {
				// If the edge is a field edge, load it with the content of the corresponding field
				if (
					edgeObject instanceof CannoliEdge &&
					edgeObject.type === EdgeType.Field
				) {
					const name = edgeObject.text;

					if (name) {
						const fieldContent = fields[name];

						if (fieldContent) {
							// If it has a note modifier, add double brackets around the note name
							if (
								edgeObject.vaultModifier === VaultModifier.Note
							) {
								edgeObject.load({
									content: `[[${fieldContent}]]`,
									request: request,
								});
							} else {
								edgeObject.load({
									content: fieldContent,
									request: request,
								});
							}
						}
					}
				} else {
					edgeObject.load({
						content: formFunctionArgs,
						request: request,
					});
				}
			}
		}
	}

	logDetails(): string {
		return super.logDetails() + `Subtype: Form\n`;
	}
}

export class AccumulateNode extends CallNode {
	logDetails(): string {
		return super.logDetails() + `Subtype: Accumulate\n`;
	}
}
export class ChooseNode extends CallNode {
	getFunctions(messages: GenericCompletionResponse[]): GenericFunctionCall[] {
		const choices = this.getBranchChoices();

		// Create choice function
		const choiceFunc = this.run.createChoiceFunction(choices);

		return [choiceFunc];
	}

	loadOutgoingEdges(content: string, request: GenericCompletionParams): void {
		const messages = request.messages;

		// Get the chosen variable from the last message
		const lastMessage = messages[messages.length - 1];
		const choiceFunctionArgs =
			"function_call" in lastMessage &&
			lastMessage.function_call?.arguments;

		if (!choiceFunctionArgs) {
			this.error(`Choice function call has no arguments.`);
			return;
		}

		const parsedVariable = JSON.parse(choiceFunctionArgs);

		// Reject all unselected options
		this.rejectUnselectedOptions(parsedVariable.choice);

		super.loadOutgoingEdges(choiceFunctionArgs, request);
	}

	rejectUnselectedOptions(choice: string) {
		// Call reject on any outgoing edges that aren't the selected one
		for (const edge of this.outgoingEdges) {
			const edgeObject = this.graph[edge];
			if (edgeObject.type === EdgeType.Choice) {
				const branchEdge = edgeObject as CannoliEdge;
				if (branchEdge.text !== choice) {
					branchEdge.reject();
				}
			}
		}
	}

	getBranchChoices(): string[] {
		// Get the unique names of all outgoing choice edges
		const outgoingChoiceEdges = this.getOutgoingEdges().filter((edge) => {
			return edge.type === EdgeType.Choice;
		});

		const uniqueNames = new Set<string>();

		for (const edge of outgoingChoiceEdges) {
			const edgeObject = this.graph[edge.id];
			if (!(edgeObject instanceof CannoliEdge)) {
				throw new Error(
					`Error on object ${edgeObject.id}: object is not a branch edge.`
				);
			}

			const name = edgeObject.text;

			if (name) {
				uniqueNames.add(name);
			}
		}

		return Array.from(uniqueNames);
	}

	logDetails(): string {
		return super.logDetails() + `Subtype: Choice\n`;
	}

	validate() {
		super.validate();

		// If there are no branch edges, error
		if (
			!this.getOutgoingEdges().some(
				(edge) => edge.type === EdgeType.Choice
			)
		) {
			this.error(
				`Choice nodes must have at least one outgoing choice edge.`
			);
		}
	}
}

export class ContentNode extends CannoliNode {
	reset(): void {
		// If it's a standard content node or output node, reset the text and then call the super
		if (this.type === ContentNodeType.StandardContent || this.type === ContentNodeType.Output) {
			const name = this.getName();
			if (name !== null && this.type !== ContentNodeType.StandardContent) {
				// Clear everything except the first line
				this.text = this.text.split("\n")[0];
			} else {
				// Clear everything
				this.text = "";
			}
		}

		super.reset();
	}

	getName(): string | null {
		const firstLine = this.text.split("\n")[0].trim();
		if (
			firstLine.startsWith("[") &&
			firstLine.endsWith("]") &&
			this.type !== ContentNodeType.StandardContent
		) {
			try {
				// Check if the first line is a valid JSON array
				JSON.parse(firstLine);
				return null; // If it's a valid JSON array, return null
			} catch (e) {
				// If it's not a valid JSON array, proceed to extract the name
				return firstLine.substring(1, firstLine.length - 1);
			}
		}
		return null;
	}

	// Content is everything after the first line
	getContentCheckName(): string {
		const name = this.getName();
		if (name !== null) {
			const firstLine = this.text.split("\n")[0];
			return this.text.substring(firstLine.length + 1);
		}
		return this.text;
	}

	editContentCheckName(newContent: string): void {
		const name = this.getName();
		const firstLine = this.text.split("\n")[0];
		if (name !== null) {
			const newFirstLine = newContent.split("\n")[0].trim();
			// Check if the first line of the new content matches the current name line
			if (newFirstLine === firstLine.trim()) {
				// Discard the first line of the new content
				newContent = newContent.substring(newFirstLine.length).trim();
			}
			this.text = `${firstLine}\n${newContent}`;
		} else {
			this.text = newContent;
		}
	}

	async execute(): Promise<void> {
		this.executing();

		let content = this.getWriteOrLoggingContent();

		if (!content) {
			const variableValues = this.getVariableValues(false);

			// Get first variable value
			if (variableValues.length > 0) {
				content = variableValues[0].content || "";
			} else {
				content = "";
			}
		}

		if (content !== null && content !== undefined && content !== "") {
			this.editContentCheckName(content);
		} else {
			content = await this.processReferences();
			this.editContentCheckName(content);
		}

		// Load all outgoing edges
		this.loadOutgoingEdges(this.getContentCheckName());

		this.completed();
	}

	dependencyCompleted(dependency: CannoliObject): void {
		// If the dependency is a logging edge not crossing out of a forEach group or a chatResponse edge, execute regardless of this node's status
		if (
			(dependency instanceof LoggingEdge &&
				!dependency.crossingOutGroups.some((group) => {
					const groupObject = this.graph[group];
					if (!(groupObject instanceof CannoliGroup)) {
						throw new Error(
							`Error on object ${groupObject.id}: object is not a group.`
						);
					}
					return groupObject.type === GroupType.ForEach;
				})) ||
			dependency instanceof ChatResponseEdge
		) {
			this.execute();
		} else if (
			this.allDependenciesComplete() &&
			this.status === CannoliObjectStatus.Pending
		) {
			this.execute();
		}
	}

	logDetails(): string {
		return super.logDetails() + `Type: Content\n`;
	}

	getWriteOrLoggingContent(): string | null {
		// Get all incoming edges
		const incomingEdges = this.getIncomingEdges();

		// If there are multiple logging edges
		if (
			incomingEdges.filter((edge) => edge.type === EdgeType.Logging)
				.length > 1
		) {
			// Append the content of all logging edges
			let content = "";
			for (const edge of incomingEdges) {
				const edgeObject = this.graph[edge.id];
				if (edgeObject instanceof LoggingEdge) {
					if (edgeObject.content !== null) {
						content += edgeObject.content;
					}
				}
			}

			return content;
		}

		// Filter for incoming complete edges of type write, logging, or chatResponse, as well as edges with no text
		let filteredEdges = incomingEdges.filter(
			(edge) =>
				(edge.type === EdgeType.Write ||
					edge.type === EdgeType.Logging ||
					edge.type === EdgeType.ChatResponse ||
					edge.text.length === 0) &&
				this.graph[edge.id].status === CannoliObjectStatus.Complete
		);

		// Remove all edges with a vault modifier of type folder or property
		filteredEdges = filteredEdges.filter(
			(edge) =>
				edge.vaultModifier !== VaultModifier.Folder &&
				edge.vaultModifier !== VaultModifier.Property
		);

		if (filteredEdges.length === 0) {
			return null;
		}

		// If there are write or logging edges, return the content of the first one
		const firstEdge = filteredEdges[0];
		const firstEdgeObject = this.graph[firstEdge.id];
		if (firstEdgeObject instanceof CannoliEdge) {
			if (
				firstEdgeObject.content !== null &&
				typeof firstEdgeObject.content === "string"
			) {
				return firstEdgeObject.content;
			}
		} else {
			throw new Error(
				`Error on object ${firstEdgeObject.id}: object is not an edge.`
			);
		}

		return null;
	}
}

export class ReferenceNode extends ContentNode {
	reference: Reference;

	constructor(
		nodeData:
			| VerifiedCannoliCanvasTextData
			| VerifiedCannoliCanvasLinkData
			| VerifiedCannoliCanvasFileData,
		fullCanvasData: VerifiedCannoliCanvasData
	) {
		super(nodeData, fullCanvasData);

		if (this.references.length !== 1) {
			this.error(`Could not find reference.`);
		} else {
			this.reference = this.references[0];
		}
	}

	async execute(): Promise<void> {
		this.executing();

		let content: string | null = null;

		const writeOrLoggingContent = this.getWriteOrLoggingContent();

		const variableValues = this.getVariableValues(false);

		if (variableValues.length > 0) {
			// First, get the edges of the variable values
			const variableValueEdges = variableValues.map((variableValue) => {
				return this.graph[variableValue.edgeId ?? ""] as CannoliEdge;
			});

			// Then, filter out the edges that have the same name as the reference, or are of type folder or property
			const filteredVariableValueEdges = variableValueEdges.filter(
				(variableValueEdge) => {
					return (
						variableValueEdge.text !== this.reference.name &&
						variableValueEdge.vaultModifier !==
						VaultModifier.Folder &&
						variableValueEdge.vaultModifier !==
						VaultModifier.Property
					);
				}
			);

			// Then, filter the variable values by the filtered edges
			const filteredVariableValues = variableValues.filter(
				(variableValue) => {
					return filteredVariableValueEdges.some(
						(filteredVariableValueEdge) => {
							return (
								filteredVariableValueEdge.id ===
								variableValue.edgeId
							);
						}
					);
				}
			);

			if (filteredVariableValues.length > 0) {
				// Then, get the content of the first variable value
				content = filteredVariableValues[0].content;
			} else if (writeOrLoggingContent !== null) {
				content = writeOrLoggingContent;
			}
		} else if (writeOrLoggingContent !== null) {
			content = writeOrLoggingContent;
		}

		// Get the property edges
		const propertyEdges = this.getIncomingEdges().filter(
			(edge) =>
				edge.vaultModifier === VaultModifier.Property &&
				edge.text !== this.reference.name
		);

		if (content !== null) {
			// Append is dependent on if there is an incoming edge of type ChatResponse
			const append = this.getIncomingEdges().some(
				(edge) => edge.type === EdgeType.ChatResponse
			);

			if (
				this.reference.type === ReferenceType.CreateNote ||
				(this.reference.type === ReferenceType.Variable &&
					this.reference.shouldExtract)
			) {
				await this.processDynamicReference(content);
			} else {
				await this.editContent(content, append);

				// If there are property edges, edit the properties
				if (propertyEdges.length > 0) {
					for (const edge of propertyEdges) {
						if (
							edge.content === null ||
							edge.content === undefined ||
							typeof edge.content !== "string"
						) {
							this.error(`Property arrow has invalid content.`);
							return;
						}

						await this.editProperty(edge.text, edge.content);
					}
				}
			}

			// Load all outgoing edges
			await this.loadOutgoingEdges(content);
		} else {
			if (
				this.reference.type === ReferenceType.CreateNote ||
				(this.reference.type === ReferenceType.Variable &&
					this.reference.shouldExtract)
			) {
				await this.processDynamicReference("");

				const fetchedContent = await this.getContent();
				await this.loadOutgoingEdges(fetchedContent);
			} else {
				const fetchedContent = await this.getContent();
				await this.loadOutgoingEdges(fetchedContent);
			}

			// If there are property edges, edit the properties
			if (propertyEdges.length > 0) {
				for (const edge of propertyEdges) {
					if (
						edge.content === null ||
						edge.content === undefined ||
						typeof edge.content !== "string"
					) {
						this.error(`Property arrow has invalid content.`);
						return;
					}

					await this.editProperty(edge.text, edge.content);
				}
			}
		}

		// Load all outgoing edges
		this.completed();
	}

	async getContent(): Promise<string> {
		if (this.run.isMock) {
			return `Mock content`;
		}

		if (this.reference) {
			if (this.reference.type === ReferenceType.Note) {
				const content = await this.getContentFromNote(this.reference);
				if (content !== null && content !== undefined) {
					return content;
				} else {
					this.error(
						`Invalid reference. Could not find note "${this.reference.name}"`
					);
				}
			} else if (this.reference.type === ReferenceType.Selection) {
				const content = this.run.selection;

				if (content !== null && content !== undefined) {
					return content;
				} else {
					this.error(`Invalid reference. Could not find selection.`);
				}
			} else if (this.reference.type === ReferenceType.Floating) {
				const content = this.getContentFromFloatingNode(
					this.reference.name
				);
				if (content !== null) {
					return content;
				} else {
					this.error(
						`Invalid reference. Could not find floating node "${this.reference.name}"`
					);
				}
			} else if (this.reference.type === ReferenceType.Variable) {
				const content = this.getContentFromFloatingNode(
					this.reference.name
				);
				if (content !== null) {
					return content;
				} else {
					this.error(
						`Invalid reference. Could not find floating node "${this.reference.name}"`
					);
				}
			} else if (
				this.reference.type === ReferenceType.CreateNote
			) {
				this.error(`Dynamic reference did not process correctly.`);
			}
		}

		return `Could not find reference.`;
	}

	async processDynamicReference(content: string) {
		if (this.run.isMock) {
			return;
		}

		const incomingEdges = this.getIncomingEdges();

		// Find the incoming edge with the same name as the reference name
		const referenceNameEdge = incomingEdges.find(
			(edge) => edge.text === this.reference.name
		);

		if (!referenceNameEdge) {
			this.error(`Could not find arrow containing note name.`);
			return;
		}

		if (
			referenceNameEdge.content === null ||
			referenceNameEdge.content === undefined ||
			typeof referenceNameEdge.content !== "string"
		) {
			this.error(`Note name arrow has invalid content.`);
			return;
		}

		// Look for an incoming edge with a vault modifier of type folder
		const folderEdge = incomingEdges.find(
			(edge) => edge.vaultModifier === VaultModifier.Folder
		);

		let path = "";

		if (folderEdge) {
			if (
				folderEdge.content === null ||
				folderEdge.content === undefined ||
				typeof folderEdge.content !== "string"
			) {
				this.error(`Folder arrow has invalid content.`);
				return;
			}

			path = folderEdge.content;
		}

		// Look for incoming edges with a vault modifier of type property
		const propertyEdges = incomingEdges.filter(
			(edge) =>
				edge.vaultModifier === VaultModifier.Property &&
				edge.text !== this.reference.name
		);

		// If this reference is a create note type, create the note
		if (this.reference.type === ReferenceType.CreateNote) {
			let noteName;

			// If there are properties edges, create a yaml frontmatter section, and fill it with the properties, where the key is the edge.text and the value is the edge.content
			if (propertyEdges.length > 0) {
				let yamlFrontmatter = "---\n";

				for (const edge of propertyEdges) {
					if (
						edge.content === null ||
						edge.content === undefined ||
						typeof edge.content !== "string"
					) {
						this.error(`Property arrow has invalid content.`);
						return;
					}

					// If the edge.content is a list (starts with a dash), add a newline and two spaces, and replace all newlines with newlines and two spaces
					if (edge.content.startsWith("-")) {
						yamlFrontmatter += `${edge.text}: \n  ${edge.content
							.replace(/\n/g, "\n  ")
							.trim()}\n`;
					} else {
						yamlFrontmatter += `${edge.text}: "${edge.content}"\n`;
					}
				}

				yamlFrontmatter += "---\n";

				content = yamlFrontmatter + content;
			}

			try {
				// If there's no fileSystemInterface, throw an error
				if (!this.run.fileSystemInterface) {
					throw new Error("No fileSystemInterface found");
				}

				noteName = await this.run.fileSystemInterface.createNoteAtExistingPath(
					referenceNameEdge.content,
					path,
					content
				);
			} catch (e) {
				this.error(`Could not create note: ${e.message}`);
				return;
			}

			if (!noteName) {
				this.error(`"${referenceNameEdge.content}" already exists.`);
			} else {
				this.reference.name = noteName;
				this.reference.type = ReferenceType.Note;
			}
		} else {
			// Transform the reference
			this.reference.name = referenceNameEdge.content;
			this.reference.type = ReferenceType.Note;

			// If content is not null, edit the note
			if (content !== null) {
				await this.editContent(content, false);
			}

			// If there are property edges, edit the properties
			if (propertyEdges.length > 0) {
				for (const edge of propertyEdges) {
					if (
						edge.content === null ||
						edge.content === undefined ||
						typeof edge.content !== "string"
					) {
						this.error(`Property arrow has invalid content.`);
						return;
					}

					await this.editProperty(edge.text, edge.content);
				}
			}
		}
	}

	async editContent(newContent: string, append?: boolean): Promise<void> {
		if (this.run.isMock) {
			return;
		}

		if (this.reference) {
			if (this.reference.type === ReferenceType.Note) {
				// If there's no fileSystemInterface, throw an error
				if (!this.run.fileSystemInterface) {
					throw new Error("No fileSystemInterface found");
				}

				const edit = await this.run.fileSystemInterface.editNote(
					this.reference,
					newContent,
					append ?? false
				);

				if (edit !== null) {
					return;
				} else {
					this.error(
						`Invalid reference. Could not edit note ${this.reference.name}`
					);
				}
			} else if (this.reference.type === ReferenceType.Selection) {
				// If there's no fileSystemInterface, throw an error
				if (!this.run.fileSystemInterface) {
					throw new Error("No fileSystemInterface found");
				}

				this.run.fileSystemInterface.editSelection(newContent, this.run.isMock);
				return;
			} else if (this.reference.type === ReferenceType.Floating) {
				// Search through all nodes for a floating node with the correct name
				for (const objectId in this.graph) {
					const object = this.graph[objectId];
					if (
						object instanceof FloatingNode &&
						object.getName() === this.reference.name
					) {
						object.editContent(newContent);
						return;
					}
				}

				this.error(
					`Invalid reference. Could not find floating node ${this.reference.name}`
				);
			} else if (
				this.reference.type === ReferenceType.Variable) {
				// Search through all nodes for a floating node with the correct name
				for (const objectId in this.graph) {
					const object = this.graph[objectId];
					if (
						object instanceof FloatingNode &&
						object.getName() === this.reference.name
					) {
						object.editContent(newContent);
						return;
					}
				}

				this.error(
					`Invalid reference. Could not find floating node ${this.reference.name}`
				);
			} else if (
				this.reference.type === ReferenceType.CreateNote
			) {
				this.error(`Dynamic reference did not process correctly.`);
			}
		}
	}

	async editProperty(
		propertyName: string,
		newContent: string
	): Promise<void> {
		if (this.run.isMock) {
			return;
		}

		if (this.reference) {
			if (this.reference.type === ReferenceType.Note) {
				// If there's no fileSystemInterface, throw an error
				if (!this.run.fileSystemInterface) {
					throw new Error("No fileSystemInterface found");
				}

				const edit = await this.run.fileSystemInterface.editPropertyOfNote(
					this.reference.name,
					propertyName,
					newContent.trim()
				);

				if (edit !== null) {
					return;
				} else {
					this.error(
						`Invalid reference. Could not edit property ${propertyName} of note ${this.reference.name}`
					);
				}
			} else if (this.reference.type === ReferenceType.Floating) {
				// Search through all nodes for a floating node with the correct name

				for (const objectId in this.graph) {
					const object = this.graph[objectId];
					if (
						object instanceof FloatingNode &&
						object.getName() === this.reference.name
					) {
						object.editProperty(propertyName, newContent.trim());
						return;
					}
				}
			} else if (
				this.reference.type === ReferenceType.Variable ||
				this.reference.type === ReferenceType.CreateNote
			) {
				this.error(`Dynamic reference did not process correctly.`);
			}
		}
	}

	async loadOutgoingEdges(
		content: string,
		request?: GenericCompletionParams | undefined
	) {
		// If this is a floating node, load all outgoing edges with the content
		if (this.reference.type === ReferenceType.Floating) {
			this.loadOutgoingEdgesFloating(content, request);
			return;
		}

		for (const edge of this.outgoingEdges) {
			const edgeObject = this.graph[edge];
			if (!(edgeObject instanceof CannoliEdge)) {
				continue;
			}

			if (edgeObject.vaultModifier === VaultModifier.Property) {
				let value;

				if (edgeObject.text.length === 0) {
					// If there's no fileSystemInterface, throw an error
					if (!this.run.fileSystemInterface) {
						throw new Error("No fileSystemInterface found");
					}

					value = await this.run.fileSystemInterface.getAllPropertiesOfNote(
						this.reference.name,
						true
					);
				} else {
					// If there's no fileSystemInterface, throw an error
					if (!this.run.fileSystemInterface) {
						throw new Error("No fileSystemInterface found");
					}

					// Get value of the property with the same name as the edge
					value = await this.run.fileSystemInterface.getPropertyOfNote(
						this.reference.name,
						edgeObject.text,
						true
					);
				}

				if (value) {
					edgeObject.load({
						content: value ?? "",
						request: request,
					});
				}
			} else if (edgeObject.vaultModifier === VaultModifier.Note) {
				// Load the edge with the name of the note
				edgeObject.load({
					content: `${this.reference.name}`,
					request: request,
				});
			} else if (edgeObject.vaultModifier === VaultModifier.Folder) {
				// If there's no fileSystemInterface, throw an error
				if (!this.run.fileSystemInterface) {
					throw new Error("No fileSystemInterface found");
				}

				const path = await this.run.fileSystemInterface.getNotePath(
					this.reference.name
				);

				if (path) {
					edgeObject.load({
						content: path,
						request: request,
					});
				}
			} else if (
				edgeObject instanceof CannoliEdge &&
				!(edgeObject instanceof ChatResponseEdge)
			) {
				edgeObject.load({
					content: content,
					request: request,
				});
			}
		}
	}

	loadOutgoingEdgesFloating(
		content: string,
		request?: GenericCompletionParams | undefined
	) {
		for (const edge of this.outgoingEdges) {
			const edgeObject = this.graph[edge];
			if (!(edgeObject instanceof CannoliEdge)) {
				continue;
			}

			// If the edge has a note modifier, load it with the name of the floating node
			if (edgeObject.vaultModifier === VaultModifier.Note) {
				edgeObject.load({
					content: `${this.reference.name}`,
					request: request,
				});
			} else if (edgeObject.vaultModifier === VaultModifier.Property) {
				// Find the floating node with the same name as this reference
				let propertyContent = "";

				for (const objectId in this.graph) {
					const object = this.graph[objectId];
					if (
						object instanceof FloatingNode &&
						object.getName() === this.reference.name
					) {
						propertyContent = object.getProperty(edgeObject.text);
					}
				}

				if (propertyContent) {
					edgeObject.load({
						content: propertyContent,
						request: request,
					});
				}
			} else if (
				edgeObject instanceof CannoliEdge &&
				!(edgeObject instanceof ChatResponseEdge)
			) {
				edgeObject.load({
					content: content,
					request: request,
				});
			}
		}
	}

	logDetails(): string {
		return super.logDetails() + `Subtype: Reference\n`;
	}
}

export class HttpNode extends ContentNode {
	logDetails(): string {
		return super.logDetails() + `Subtype: Http\nIs Hook: ${this.type === ContentNodeType.Hook}\n`;
	}

	async execute(): Promise<void> {
		this.executing();

		let hookId: string | null = null;
		let content: string;

		if (this.type === ContentNodeType.Hook) {
			const hookResult = await this.handleHookCreation();
			if (hookResult instanceof Error) {
				this.error(hookResult.message);
				return;
			}
			({ hookId, content } = hookResult);
		} else {
			content = await this.processReferences([], true);
		}

		const request = this.parseContentToRequest(content);
		if (request instanceof Error) {
			this.error(request.message);
			return;
		}

		const result = await this.run.executeHttpRequest(request);

		if (result instanceof Error) {
			this.error(result.message);
			return;
		}

		if (this.type === ContentNodeType.Hook) {
			const response = await this.waitForHookResponse(hookId);
			this.loadOutgoingEdges(response);
		} else {
			this.loadOutgoingEdges(result);
		}

		this.completed();
	}

	private async handleHookCreation(): Promise<{ hookId: string | null, content: string } | Error> {
		if (!this.references.some((reference) => reference.name === "ID")) {
			return new Error(`You must send the ID of the hook using the "{{ID}}" variable to get a response.`);
		}

		if (!this.run.receiver) {
			return new Error(`No receiver found.`);
		}

		const hookCreationResponse = await this.run.receiver.createHook(this.run.isMock);
		if (hookCreationResponse instanceof Error) {
			return new Error(`Could not create hook: ${hookCreationResponse.message}`);
		}

		const hookId = hookCreationResponse;
		if (hookId === null) {
			return new Error(`Could not create hook.`);
		}

		const hookIdValue: VariableValue = {
			name: "ID",
			content: hookId,
			edgeId: null
		};

		const content = await this.processReferences([hookIdValue], true);
		return { hookId, content };
	}

	private parseContentToRequest(content: string): HttpRequest | Error {
		// If the content is wrapped in triple backticks with or without a language identifier, remove them
		content = content.replace(/^```[^\n]*\n([\s\S]*?)\n```$/, '$1').trim();

		if (typeof content === "string" && (content.startsWith("http://") || content.startsWith("https://"))) {
			return { url: content, method: "GET" };
		}

		try {
			const parsedContent = JSON.parse(content);
			if (parsedContent && parsedContent.url) {
				return parsedContent as HttpRequest;
			}
		} catch (e) {
			// Continue to next parsing method
		}

		const variables = this.getVariables();
		const template = this.getTemplate(content);
		if (template instanceof Error) {
			return template;
		}

		const request = this.run.convertTemplateToRequest(template, variables);
		if (request instanceof Error) {
			return request;
		}

		return request;
	}

	private getVariables(): string | Record<string, string> | null {
		let variables: string | Record<string, string> | null = this.getWriteOrLoggingContent();

		if (!variables) {
			const variableValues = this.getVariableValues(false);
			if (variableValues.length > 0) {
				variables = {};
				for (const variableValue of variableValues) {
					variables[variableValue.name] = variableValue.content || "";
				}
			}
		}

		return variables;
	}

	private getTemplate(name: string): HttpTemplate | Error {
		console.log(`Getting template for ${name}`);

		for (const objectId in this.graph) {
			const object = this.graph[objectId];
			if (object instanceof FloatingNode && object.getName() === name) {
				// If the text is wrapped in triple backticks with or without a language identifier, remove them
				const text = object.getContent().replace(/^```[^\n]*\n([\s\S]*?)\n```$/, '$1').trim();

				try {
					const template = JSON.parse(text) as HttpTemplate;

					// Check that the template has a url and method
					if (!template.url || !template.method) {
						return new Error(`Floating node "${name}" does not have a valid HTTP template.`);
					}

					// Convert the body template to a string
					if (template.bodyTemplate) {
						template.bodyTemplate = JSON.stringify(template.bodyTemplate);
					}

					return template;
				} catch (e) {
					return new Error(`Floating node "${name}" could not be parsed as an HTTP template.`);
				}

			}
		}

		if (!this.run.fileSystemInterface) {
			return new Error("No fileSystemInterface found");
		}

		const settingsTemplate = this.run.fileSystemInterface.getHttpTemplateByName(name);
		if (settingsTemplate instanceof Error) {
			return new Error(`Could not get HTTP template with name "${name}" from floating nodes or pre-set templates.`);
		}

		return settingsTemplate;
	}

	private async waitForHookResponse(hookId: string | null): Promise<string> {
		if (!this.run.receiver) {
			this.warning(`No receiver found.`);
			return "No receiver found.";
		}

		if (hookId === null) {
			this.warning(`Hook ID not found.`);
			return "Could not get hook response.";
		}

		const shouldContinueWaiting = () => !this.run.isStopped;

		const response: string | Error = await this.run.receiver.getHookResponse(hookId, this.run.isMock, shouldContinueWaiting);
		if (response instanceof Error) {
			this.warning(`Could not get hook response: ${response.message}`);
			return "Could not get hook response.";
		}

		return response;
	}
}

export class FormatterNode extends ContentNode {
	logDetails(): string {
		return super.logDetails() + `Subtype: Formatter\n`;
	}

	async execute(): Promise<void> {
		this.executing();

		const content = await this.processReferences();

		// Take off the first 2 and last 2 characters (the double double quotes)
		const processedContent = content.slice(2, -2);

		// Load all outgoing edges
		this.loadOutgoingEdges(processedContent);

		this.completed();
	}
}

export class FloatingNode extends CannoliNode {
	constructor(
		nodeData:
			| VerifiedCannoliCanvasTextData
			| VerifiedCannoliCanvasLinkData
			| VerifiedCannoliCanvasFileData,
		fullCanvasData: VerifiedCannoliCanvasData
	) {
		super(nodeData, fullCanvasData);
		this.status = CannoliObjectStatus.Complete;
	}

	dependencyCompleted(dependency: CannoliObject): void {
		return;
	}

	dependencyRejected(dependency: CannoliObject): void {
		return;
	}

	async execute() {
		this.completed();
	}

	getName(): string {
		const firstLine = this.text.split("\n")[0].trim();
		// Take the first and last characters off the first line
		return firstLine.substring(1, firstLine.length - 1);
	}

	// Content is everything after the first line
	getContent(): string {
		const firstLine = this.text.split("\n")[0];
		return this.text.substring(firstLine.length + 1);
	}

	editContent(newContent: string): void {
		const firstLine = this.text.split("\n")[0];
		this.text = `${firstLine}\n${newContent}`;

		const event = new CustomEvent("update", {
			detail: { obj: this, status: this.status },
		});
		this.dispatchEvent(event);
	}

	editProperty(propertyName: string, newContent: string): void {
		// Find the frontmatter from the content
		const frontmatter = this.getContent().split("---")[1];

		if (!frontmatter) {
			return;
		}

		const parsedFrontmatter: Record<string, string> = yaml.load(
			frontmatter
		) as Record<string, string>;

		// If the parsed frontmatter is null, return
		if (!parsedFrontmatter) {
			return;
		}

		// Set the property to the new content
		parsedFrontmatter[propertyName] = newContent;

		// Stringify the frontmatter and add it back to the content
		const newFrontmatter = yaml.dump(parsedFrontmatter);

		const newProps = `---\n${newFrontmatter}---\n${this.getContent().split("---")[2]
			}`;

		this.editContent(newProps);
	}

	getProperty(propertyName: string): string {
		// If property name is empty, return the entire frontmatter
		if (propertyName.length === 0) {
			return this.getContent().split("---")[1];
		}

		// Find the frontmatter from the content
		const frontmatter = this.getContent().split("---")[1];

		if (!frontmatter) {
			return "";
		}

		const parsedFrontmatter: Record<string, string> = yaml.load(
			frontmatter
		) as Record<string, string>;

		// If the parsed frontmatter is null, return
		if (!parsedFrontmatter) {
			return "";
		}

		return parsedFrontmatter[propertyName];
	}

	logDetails(): string {
		return (
			super.logDetails() +
			`Type: Floating\nName: ${this.getName()}\nContent: ${this.getContent()}\n`
		);
	}
}

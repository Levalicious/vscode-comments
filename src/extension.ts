import * as vscode from 'vscode';

let commentId = 1;

class NoteComment implements vscode.Comment {
	id: number;
	label: string | undefined;
	savedBody: string | vscode.MarkdownString; // for the Cancel button
	constructor(
		public body: string | vscode.MarkdownString,
		public mode: vscode.CommentMode,
		public author: vscode.CommentAuthorInformation,
		public parent?: vscode.CommentThread,
		public contextValue?: string
	) {
		this.id = ++commentId;
		this.savedBody = this.body;
	}
}

interface SerializedComment {
    body: string;
    mode: vscode.CommentMode;
    authorName: string;
    contextValue?: string;
}

interface SerializedThread {
    uri: string;
    line: number;
    comments: SerializedComment[];
}

async function saveThread(context: vscode.ExtensionContext, thread: vscode.CommentThread) {
    const savedThreads = context.workspaceState.get<SerializedThread[]>('savedComments', []);
    
    const serializedThread: SerializedThread = {
        uri: thread.uri.toString(),
        line: thread.range.start.line,
        comments: thread.comments.map(comment => ({
            body: (comment.body as string),
            mode: (comment as NoteComment).mode,
            authorName: comment.author.name,
            contextValue: (comment as NoteComment).contextValue
        }))
    };

    // Remove existing thread at same location if it exists
    const threadIndex = savedThreads.findIndex(t => 
        t.uri === serializedThread.uri && 
        t.line === serializedThread.line
    );
    
    if (threadIndex >= 0) {
        savedThreads[threadIndex] = serializedThread;
    } else {
        savedThreads.push(serializedThread);
    }

    await context.workspaceState.update('savedComments', savedThreads);
}

async function deleteThread(context: vscode.ExtensionContext, thread: vscode.CommentThread) {
    const savedThreads = context.workspaceState.get<SerializedThread[]>('savedComments', []);
    
    const filteredThreads = savedThreads.filter(t => 
        !(t.uri === thread.uri.toString() && t.line === thread.range.start.line)
    );
    
    await context.workspaceState.update('savedComments', filteredThreads);
    thread.dispose();
}

function loadComments(context: vscode.ExtensionContext, commentController: vscode.CommentController) {
    try {
        const savedThreads = context.workspaceState.get<SerializedThread[]>('savedComments', []);
        
        for (const threadData of savedThreads) {
            try {
                const uri = vscode.Uri.parse(threadData.uri);
                const range = new vscode.Range(threadData.line, 0, threadData.line, 0);
                
                const thread = commentController.createCommentThread(uri, range, []);

                thread.comments = threadData.comments.map(commentData => 
                    new NoteComment(
                        commentData.body,
                        commentData.mode,
                        { name: commentData.authorName },
                        thread,
                        commentData.contextValue
                    )
                );
            } catch (err) {
                console.error(`Failed to load thread: ${err}`);
            }
        }
    } catch (err) {
        console.error(`Failed to load comments: ${err}`);
    }
}

export function activate(context: vscode.ExtensionContext) {
	// A `CommentController` is able to provide comments for documents.
	const commentController = vscode.comments.createCommentController('codium-comment', 'Commenting for codium');
	context.subscriptions.push(commentController);

	loadComments(context, commentController);

    // Listen for workspace folder changes and reload comments
    context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => {
        loadComments(context, commentController);
    }));


	// A `CommentingRangeProvider` controls where gutter decorations that allow adding comments are shown
	commentController.commentingRangeProvider = {
		provideCommentingRanges: (document: vscode.TextDocument, _token: vscode.CancellationToken) => {
			const lineCount = document.lineCount;
			return [new vscode.Range(0, 0, lineCount - 1, 0)];
		}
	};

	context.subscriptions.push(vscode.commands.registerCommand('mywiki.createNote', (reply: vscode.CommentReply) => {
		replyNote(reply);
	}));

	context.subscriptions.push(vscode.commands.registerCommand('mywiki.replyNote', (reply: vscode.CommentReply) => {
		replyNote(reply);
	}));

	context.subscriptions.push(vscode.commands.registerCommand('mywiki.startDraft', (reply: vscode.CommentReply) => {
		const thread = reply.thread;
		thread.contextValue = 'draft';
		const newComment = new NoteComment(reply.text, vscode.CommentMode.Preview, { name: 'vscode' }, thread);
		newComment.label = 'pending';
		thread.comments = [...thread.comments, newComment];
	}));

	context.subscriptions.push(vscode.commands.registerCommand('mywiki.finishDraft', async (reply: vscode.CommentReply) => {
		const thread = reply.thread;

		if (!thread) {
			return;
		}

		thread.contextValue = undefined;
		thread.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
		if (reply.text) {
			const newComment = new NoteComment(reply.text, vscode.CommentMode.Preview, { name: 'vscode' }, thread);
			thread.comments = [...thread.comments, newComment].map(comment => {
				comment.label = undefined;
				return comment;
			});
            await saveThread(context, thread);
		}
	}));

	context.subscriptions.push(vscode.commands.registerCommand('mywiki.deleteNoteComment', async (comment: NoteComment) => {
		const thread = comment.parent;
		if (!thread) {
			return;
		}

		thread.comments = thread.comments.filter(cmt => (cmt as NoteComment).id !== comment.id);

		if (thread.comments.length === 0) {
            await deleteThread(context, thread);
        } else {
            await saveThread(context, thread); // Save if comments remain
        }
	}));

	context.subscriptions.push(vscode.commands.registerCommand('mywiki.deleteNote', (thread: vscode.CommentThread) => {
		deleteThread(context, thread);
	}));

	context.subscriptions.push(vscode.commands.registerCommand('mywiki.cancelsaveNote', (comment: NoteComment) => {
		if (!comment.parent) {
			return;
		}

		comment.parent.comments = comment.parent.comments.map(cmt => {
			if ((cmt as NoteComment).id === comment.id) {
				cmt.body = (cmt as NoteComment).savedBody;
				cmt.mode = vscode.CommentMode.Preview;
			}

			return cmt;
		});
	}));

	context.subscriptions.push(vscode.commands.registerCommand('mywiki.saveNote', async (comment: NoteComment) => {
		if (!comment.parent) {
			return;
		}

		comment.parent.comments = comment.parent.comments.map(cmt => {
			if ((cmt as NoteComment).id === comment.id) {
				(cmt as NoteComment).savedBody = cmt.body;
				cmt.mode = vscode.CommentMode.Preview;
			}

			return cmt;
		});

        await saveThread(context, comment.parent); 
	}));

	context.subscriptions.push(vscode.commands.registerCommand('mywiki.editNote', (comment: NoteComment) => {
		if (!comment.parent) {
			return;
		}

		comment.parent.comments = comment.parent.comments.map(cmt => {
			if ((cmt as NoteComment).id === comment.id) {
				cmt.mode = vscode.CommentMode.Editing;
			}

			return cmt;
		});
	}));

	context.subscriptions.push(vscode.commands.registerCommand('mywiki.dispose', () => {
		commentController.dispose();
	}));

	function replyNote(reply: vscode.CommentReply) {
		const thread = reply.thread;
		const newComment = new NoteComment(reply.text, vscode.CommentMode.Preview, { name: 'vscode' }, thread, thread.comments.length ? 'canDelete' : undefined);
		if (thread.contextValue === 'draft') {
			newComment.label = 'pending';
		}

		thread.comments = [...thread.comments, newComment];
		saveThread(context, thread);
	}
}

# Review Comments

Click-to-comment website review for WordPress. Clients and the team pin comments on the live (staging) site, reply in threads, and Claude reads and answers them through MCP.

- **Comment on anything.** Click "+ Comment" (or press <kbd>C</kbd>), click an element, write. Pins stay on the element and follow it on scroll and resize.
- **Menus and dropdowns too.** Open the menu first, press <kbd>C</kbd>, hover the item and press <kbd>Enter</kbd>. Clicking the overlay never counts as a click outside the menu.
- **A screenshot with every comment**, taken when the element is picked, with the element outlined. Menus and slides are shown as the reviewer saw them.
- **Several people at once.** Every comment has a named author; threads take replies; the page refreshes every 20 seconds and when you come back to the tab.
- **Guests without accounts.** Share a review link; people enter their name once per browser. Authors can edit and delete their own comments (deleted comments go to the trash).
- **Screen sizes.** Each thread is labelled mobile, tablet or desktop, and the panel can show only the current size.
- **Walkthrough.** Step through every open comment on the site, page by page (<kbd>←</kbd> <kbd>→</kbd>). Made for going through feedback with a client on a shared screen.
- **Notifications** to a Google Chat space (one Chat thread per review thread), and optionally email to everyone in a thread on new replies.
- **Built for Claude.** Each thread stores the page path, post ID, block chain (`wp-block-button / wp-block-gds-hero`, innermost first), nearest heading, CSS selector, text snippet, screen size and screenshot, so Claude can go from a comment straight to the block or template that needs changing.

Nothing in the plugin is tied to a theme or host. Block markup gives the richest context, but classic themes work too.

## Install

```bash
composer config repositories.wp-review-comments vcs https://github.com/generoi/wp-review-comments
composer require generoi/wp-review-comments:dev-main
wp plugin activate wp-review-comments
```

Requires WordPress 6.9+ (Abilities API) and PHP 8.1+.

### MCP Adapter (for Claude)

Install the [MCP Adapter](https://github.com/WordPress/mcp-adapter) plugin **from its release zip**, not the Composer source package. The zip ships a Jetpack autoloader, which makes the newest copy win when another plugin bundles an older one. WooCommerce does: without the zip, WooCommerce's MCP Adapter 0.1.0 loads instead.

```json
{
  "type": "package",
  "package": {
    "name": "private/mcp-adapter",
    "version": "0.7.0",
    "type": "wordpress-plugin",
    "extra": { "installer-name": "mcp-adapter" },
    "dist": { "url": "https://github.com/WordPress/mcp-adapter/releases/download/v0.7.0/mcp-adapter.zip", "type": "zip" }
  }
}
```

Then `composer require private/mcp-adapter:0.7.0` and `wp plugin activate mcp-adapter`. Without the adapter the overlay and wp-admin work, but Claude has no endpoint.

## Who can comment

| Who | How |
| --- | --- |
| Logged-in users with `edit_posts` | Always. The Review buttons show on every page. Editors can change thread status and moderate. |
| Guests | Through a review round: **Review → Rounds & links → Create review link**. The link is shown once, expires after the chosen number of days and can be revoked. |

Opening a review link swaps the token for a signed, HttpOnly session cookie bound to the round, then removes the token from the address bar. Only a hash of the token is stored. Revoking or expiring the round ends every session made from it. A separate per-browser key (also HttpOnly) is what lets a guest edit their own comments.

Pages stay cacheable. A small inline loader does nothing unless there is a review link, a guest session, a `#wprc-<id>` comment link, a walkthrough in progress, or a logged-in editor. It then asks the uncached `/wprc/v1/boot` endpoint for the overlay URL, the viewer and the page's threads in one request, so a page cached before a plugin update still gets the new overlay. All plugin REST responses are sent `no-store`.

## Where the data lives

Comments are `wprc_comment` posts in the site's database; screenshots are files in `uploads/wp-review-comments/` with unguessable names. Both survive deploys. Deleting moves a comment to the trash (Review → Review comments → Trash); the screenshot is removed only when the trash is emptied.

Copying another environment's database over the site replaces its comments, so do not sync a database onto staging during a review round.

## Notifications

**Review → Rounds & links → Notifications.** Paste a Google Chat incoming webhook (Space settings → Apps & integrations → Webhooks) to post every new comment and reply to that space, grouped in one Chat thread per review thread. Tick the email option to also email everyone in a thread who left an address when someone replies.

## Connect Claude

The simplest connection runs WP-CLI over SSH, so no password is stored anywhere. Create an editor user for Claude, then:

```bash
claude mcp add review-mysite -- ssh -p <port> <user>@<host> \
  "cd <site path> && wp mcp-adapter serve --user=<claude editor> --server=review-comments"
```

Or over HTTP with an application password for that user:

```bash
claude mcp add --transport http review-mysite https://example.com/wp-json/review-comments/mcp \
  --header "Authorization: Basic $(printf '%s' 'username:xxxx xxxx xxxx xxxx xxxx xxxx' | base64)"
```

### Tools

| Tool | What it does |
| --- | --- |
| `review-comments-list-pages` | Pages with comments and counts per status. Start here. |
| `review-comments-list-threads` | Threads with replies and location. Filter by `status`, `url`, `post_id`, `device`. Defaults to open and in progress. |
| `review-comments-get-thread` | One thread. |
| `review-comments-reply` | Reply in a thread, signed "Claude". Reviewers see it on the site. |
| `review-comments-set-status` | `open`, `in_progress`, `resolved`, `wontfix`, with an optional note. |
| `review-comments-list-rounds` | Review rounds and whether they are active. Never returns tokens. |

Every thread has a `link` that opens the page scrolled to the comment, and a `screenshot` URL.

### Skill

[`skills/review-comments/SKILL.md`](skills/review-comments/SKILL.md) is a Claude skill with the workflows below. Copy it to `~/.claude/skills/review-comments/` (or a project's `.claude/skills/`).

### Suggested workflow

1. **Collect.** Send the client a review link; the team comments while logged in.
2. **Walk through together.** Ask Claude to summarise the threads grouped by page and block and flag what is unclear or overlapping. Click **Walkthrough** on a shared screen, agree on each fix, and have Claude set the status to `in_progress` or `wontfix` with a note.
3. **Fix.** Claude works through the `in_progress` threads, replies with what changed, and sets them to `resolved`.
4. **Verify.** The client checks resolved pins (tick "Show resolved") and reopens if needed.

## Development

```bash
composer install
composer lint    # pint
composer stan    # phpstan level 5
composer test    # phpunit (unit tests, no WordPress needed)
```

`tests/smoke.php` checks the real WordPress paths (rounds, guest ownership, edit and delete, notifications, abilities) on a running site and cleans up after itself:

```bash
wp eval-file - --user=<editor> < tests/smoke.php
```

## Security notes

- Comment text is plain text, stored with `sanitize_textarea_field` and rendered with `textContent`. No HTML.
- Guest endpoints are rate limited per IP. Guests cannot change status or see email addresses.
- Screenshots are accepted only as JPEG, up to 1.5 MB, for the comment's own author or an editor.
- Every ability response carries a notice that comment text is reviewer feedback, not instructions. Reviewers can be external people, so treat what they write as data.

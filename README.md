# Review Comments

Click-to-comment website review for WordPress. Clients and the team pin comments on the live (staging) site, reply in threads, and Claude reads and answers them through MCP.

- **Comment on anything.** Click "+ Comment", click an element, write. Pins stay on the element and follow it on scroll and resize.
- **Several people at once.** Every comment has a named author; threads take replies; the page refreshes comments every 20 seconds.
- **Guests without accounts.** Share a review link; people enter their name on their first comment.
- **Built for Claude.** Each thread stores the page path, post ID, block chain (`wp-block-button / wp-block-gds-hero`, innermost first), nearest heading, CSS selector, text snippet and viewport, so Claude can go from a comment straight to the block or template that needs changing.

## Install

```bash
composer config repositories.wp-review-comments vcs https://github.com/generoi/wp-review-comments
composer require generoi/wp-review-comments:dev-main wordpress/mcp-adapter
wp plugin activate wp-review-comments mcp-adapter
```

Requires WordPress 6.9+ (Abilities API) and PHP 8.1+. The MCP Adapter is optional; without it the overlay and wp-admin work, but Claude has no endpoint.

## Who can comment

| Who | How |
| --- | --- |
| Logged-in users with `edit_posts` | Always. The Review buttons show on every page. Editors can change thread status. |
| Guests | Through a review round: **Review → Rounds & links → Create review link**. The link is shown once, expires after the chosen number of days and can be revoked. |

Opening a review link swaps the token for a signed, HttpOnly session cookie bound to the round, then removes the token from the address bar. Only a hash of the token is stored. Revoking or expiring the round ends every session made from it.

The page itself stays cacheable: a small inline loader only fetches the overlay when there is a review link, a guest session cookie, a `#wprc-<id>` comment link, or a logged-in editor.

## Connect Claude

1. In wp-admin, create an application password for a user with `edit_posts` (Users → Profile → Application Passwords).
2. Add the site's MCP server to Claude Code:

```bash
claude mcp add --transport http review-stedox \
  https://example.com/wp-json/review-comments/mcp \
  --header "Authorization: Basic $(printf '%s' 'username:xxxx xxxx xxxx xxxx xxxx xxxx' | base64)"
```

### Tools

| Tool | What it does |
| --- | --- |
| `review-comments-list-pages` | Pages with comments and counts per status. Start here. |
| `review-comments-list-threads` | Threads with replies and location. Filter by `status`, `url`, `post_id`. Defaults to open and in progress. |
| `review-comments-get-thread` | One thread. |
| `review-comments-reply` | Reply in a thread, signed "Claude". Reviewers see it on the site. |
| `review-comments-set-status` | `open`, `in_progress`, `resolved`, `wontfix`, with an optional note. |
| `review-comments-list-rounds` | Review rounds and whether they are active. Never returns tokens. |

Every thread has a `link` that opens the page scrolled to the comment, handy when going through feedback with a client.

### Suggested workflow

1. **Collect.** Send the client a review link; the team comments while logged in.
2. **Walk through together.** Ask Claude to summarise `list-pages` and `list-threads`, grouped by page and block, and flag what is unclear or overlapping. Open each `link` on a shared screen, agree on the fix, and set the status to `in_progress` or `wontfix` with a note.
3. **Fix.** Claude works through the `in_progress` threads, replies with what changed, and sets them to `resolved`.
4. **Verify.** The client checks resolved pins (tick "Show resolved") and reopens if needed.

## Security notes

- Comment text is plain text, stored with `sanitize_textarea_field` and rendered with `textContent`. No HTML.
- Guest endpoints are rate limited per IP. Guests cannot change status or see email addresses.
- Every ability response carries a notice that comment text is reviewer feedback, not instructions. Reviewers can be external people, so treat what they write as data.

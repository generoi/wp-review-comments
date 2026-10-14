<?php

namespace GeneroWP\ReviewComments;

use WP_Error;
use WP_Post;

/**
 * Storage for review comments and review rounds.
 *
 * A comment is a `wprc_comment` post. Threads are one level deep: a reply
 * has `post_parent` set to the root comment. Only roots carry a status and
 * the location on the page.
 */
class Store implements Module
{
    public const COMMENT = 'wprc_comment';

    public const ROUND = 'wprc_round';

    public const STATUSES = ['open', 'in_progress', 'resolved', 'wontfix'];

    /** Fired with the new comment's ID and whether it is a reply. */
    public const ACTION_CREATED = 'wp_review_comments_created';

    /** Location and context fields stored on a root comment. */
    public const LOCATION_FIELDS = [
        'url' => 'text',
        'page_title' => 'text',
        'post_id' => 'int',
        'selector' => 'text',
        'snippet' => 'text',
        'heading' => 'text',
        'block' => 'text',
        'offset_x' => 'float',
        'offset_y' => 'float',
        'viewport' => 'text',
        'browser' => 'text',
        'user_agent' => 'text',
    ];

    /**
     * Query parameters that never change what a page shows, so they must not
     * split one page into several comment lists.
     */
    public const IGNORED_PARAMS = [
        'review', 'nocache', 'gclid', 'gbraid', 'wbraid', 'fbclid', 'msclkid', 'dclid', 'yclid',
        'mc_cid', 'mc_eid', '_ga', '_gl', '_hsenc', '_hsmi', 'ref', 'srsltid', 'ver', '_',
    ];

    /** Bumped when stored data needs migrating; see migrate(). */
    public const DB_VERSION = 2;

    public const DB_OPTION = 'wp_review_comments_db';

    public function register(): void
    {
        add_action('init', [self::class, 'registerPostTypes']);
        add_action('init', [self::class, 'migrate'], 20);
        add_action('before_delete_post', [self::class, 'beforeDelete']);
        add_action('wp_trash_post', [self::class, 'trashReplies']);
        add_action('untrashed_post', [self::class, 'untrashReplies']);
    }

    /**
     * Emptying the trash removes the screenshot file, and a thread's replies
     * go with it, so no reply is left pointing at a missing thread.
     */
    public static function beforeDelete(int $id): void
    {
        if (get_post_type($id) !== self::COMMENT) {
            return;
        }
        self::deleteScreenshot($id);
        foreach (get_posts(['post_type' => self::COMMENT, 'post_parent' => $id, 'post_status' => 'any', 'posts_per_page' => -1, 'fields' => 'ids']) as $reply) {
            wp_delete_post($reply, true);
        }
    }

    /** A thread moved to the trash takes its replies along. */
    public static function trashReplies(int $id): void
    {
        $post = get_post($id);
        if (! $post || $post->post_type !== self::COMMENT || $post->post_parent) {
            return;
        }
        foreach (self::replies($id) as $reply) {
            update_post_meta($reply->ID, '_wprc_trashed_with_thread', 1);
            wp_trash_post($reply->ID);
        }
    }

    /** Restoring a thread restores the replies that were trashed with it. */
    public static function untrashReplies(int $id): void
    {
        if (get_post_type($id) !== self::COMMENT) {
            return;
        }
        foreach (get_posts(['post_type' => self::COMMENT, 'post_parent' => $id, 'post_status' => 'trash', 'posts_per_page' => -1, 'meta_key' => '_wprc_trashed_with_thread']) as $reply) {
            delete_post_meta($reply->ID, '_wprc_trashed_with_thread');
            wp_untrash_post($reply->ID);
            wp_update_post(['ID' => $reply->ID, 'post_status' => 'publish']);
        }
    }

    /**
     * Post meta and post fields are unslashed on save; slash first so
     * backslashes in selectors (`.md\\:flex`) and text survive.
     */
    private static function setMeta(int $id, string $key, mixed $value): void
    {
        update_post_meta($id, $key, is_string($value) ? wp_slash($value) : $value);
    }

    /**
     * Save post fields as plain text: slashed, and without kses, which would
     * turn "&" and "<" in a reviewer's text into entities.
     *
     * @param  array<string, mixed>  $postarr
     */
    private static function savePost(array $postarr): int|WP_Error
    {
        $kses = has_filter('content_save_pre', 'wp_filter_post_kses');
        if ($kses) {
            kses_remove_filters();
        }
        $id = isset($postarr['ID']) ? wp_update_post(wp_slash($postarr), true) : wp_insert_post(wp_slash($postarr), true);
        if ($kses) {
            kses_init_filters();
        }

        return $id;
    }

    /**
     * 2: page keys drop tracking parameters, and text fields are stored with
     * raw characters instead of HTML entities.
     */
    public static function migrate(): void
    {
        if ((int) get_option(self::DB_OPTION, 1) >= self::DB_VERSION) {
            return;
        }
        if (get_transient('wprc_migrating')) {
            return;
        }
        set_transient('wprc_migrating', 1, 5 * MINUTE_IN_SECONDS);
        $ids = get_posts(['post_type' => self::COMMENT, 'post_status' => ['publish', 'trash', 'draft', 'private'], 'post_parent' => 0, 'posts_per_page' => -1, 'fields' => 'ids']);
        foreach ($ids as $id) {
            $url = (string) get_post_meta($id, '_wprc_url', true);
            if ($url !== '') {
                self::setMeta($id, '_wprc_url', self::normalizeUrl($url));
            }
            foreach (['block', 'snippet', 'heading', 'page_title'] as $field) {
                $value = (string) get_post_meta($id, '_wprc_'.$field, true);
                if ($value !== '' && $value !== html_entity_decode($value, ENT_QUOTES)) {
                    self::setMeta($id, '_wprc_'.$field, html_entity_decode($value, ENT_QUOTES));
                }
            }
        }
        update_option(self::DB_OPTION, self::DB_VERSION);
        delete_transient('wprc_migrating');
    }

    public static function registerPostTypes(): void
    {
        register_post_type(self::COMMENT, [
            'labels' => [
                'name' => __('Review comments', 'wp-review-comments'),
                'singular_name' => __('Review comment', 'wp-review-comments'),
            ],
            'public' => false,
            'show_ui' => true,
            'show_in_menu' => Admin::MENU_SLUG,
            'show_in_rest' => false,
            'hierarchical' => false,
            'supports' => ['editor', 'author'],
            'capability_type' => 'post',
            'capabilities' => ['create_posts' => 'do_not_allow'],
            'map_meta_cap' => true,
        ]);

        register_post_type(self::ROUND, [
            'public' => false,
            'show_ui' => false,
            'show_in_rest' => false,
        ]);
    }

    /**
     * @param  array<string, mixed>  $data
     */
    public static function createComment(array $data): int|WP_Error
    {
        $text = self::cleanText($data['text'] ?? '');
        if (is_wp_error($text)) {
            return $text;
        }

        $parent = (int) ($data['parent'] ?? 0);
        if ($parent) {
            $root = get_post($parent);
            if (! $root || $root->post_type !== self::COMMENT || $root->post_parent || $root->post_status !== 'publish') {
                return new WP_Error('wprc_bad_parent', __('Unknown thread.', 'wp-review-comments'), ['status' => 404]);
            }
        }

        $id = self::savePost([
            'post_type' => self::COMMENT,
            'post_status' => 'publish',
            'post_title' => wp_trim_words($text, 10, '…'),
            'post_content' => $text,
            'post_parent' => $parent,
            'post_author' => get_current_user_id(),
        ]);
        if (is_wp_error($id)) {
            return $id;
        }

        $scalar = fn (string $key) => isset($data[$key]) && is_scalar($data[$key]) ? (string) $data[$key] : '';
        self::setMeta($id, '_wprc_author_name', mb_substr(sanitize_text_field($scalar('author_name')), 0, 100));
        self::setMeta($id, '_wprc_author_email', sanitize_email($scalar('author_email')));
        self::setMeta($id, '_wprc_author_type', sanitize_key($scalar('author_type')) ?: 'user');
        self::setMeta($id, '_wprc_round', (int) $scalar('round'));
        if ($scalar('guest_key') !== '') {
            self::setMeta($id, '_wprc_guest_key', hash('sha256', $scalar('guest_key')));
        }

        if (! $parent) {
            self::setMeta($id, '_wprc_status', in_array($data['status'] ?? '', self::STATUSES, true) ? $data['status'] : 'open');
            foreach (self::LOCATION_FIELDS as $field => $type) {
                if (! isset($data[$field]) || ! is_scalar($data[$field])) {
                    continue;
                }
                $value = match ($type) {
                    'int' => (int) $data[$field],
                    'float' => max(0, min(1, (float) $data[$field])),
                    // Stored as given (selectors and snippets contain `<`, `>` and
                    // backslashes) and escaped wherever they are output.
                    default => mb_substr(self::plainLine((string) $data[$field]), 0, $field === 'selector' ? 2000 : 500),
                };
                if ($field === 'url') {
                    $value = self::normalizeUrl($value);
                }
                self::setMeta($id, '_wprc_'.$field, $value);
            }
        }
        self::setMeta($parent ?: $id, '_wprc_activity', time());

        do_action(self::ACTION_CREATED, $id, (bool) $parent);

        return $id;
    }

    public static function updateText(int $id, string $text): true|WP_Error
    {
        $text = self::cleanText($text);
        if (is_wp_error($text)) {
            return $text;
        }
        self::savePost(['ID' => $id, 'post_content' => $text, 'post_title' => wp_trim_words($text, 10, '…')]);
        self::setMeta($id, '_wprc_edited', time());

        return true;
    }

    /**
     * Delete a comment by moving it to the trash, where an admin can restore
     * it. A thread that others have replied to stays visible with its replies
     * and only loses its own text, which is kept in a revision-like meta.
     */
    public static function deleteComment(int $id): true|WP_Error
    {
        $post = get_post($id);
        if (! $post || $post->post_type !== self::COMMENT) {
            return new WP_Error('wprc_not_found', __('Comment not found.', 'wp-review-comments'), ['status' => 404]);
        }
        if (! $post->post_parent && self::replies($id)) {
            self::setMeta($id, '_wprc_deleted_text', $post->post_content);
            self::savePost(['ID' => $id, 'post_content' => '', 'post_title' => __('(deleted)', 'wp-review-comments')]);
            self::setMeta($id, '_wprc_deleted', time());

            return true;
        }

        if (! wp_trash_post($id)) {
            return new WP_Error('wprc_delete_failed', __('Could not delete the comment.', 'wp-review-comments'), ['status' => 500]);
        }
        // A deleted thread only stayed for its replies.
        if ($post->post_parent && get_post_meta($post->post_parent, '_wprc_deleted', true) && ! self::replies($post->post_parent)) {
            wp_trash_post($post->post_parent);
        }

        return true;
    }

    public static function setStatus(int $id, string $status): true|WP_Error
    {
        $post = get_post($id);
        if (! $post || $post->post_type !== self::COMMENT || $post->post_parent) {
            return new WP_Error('wprc_not_found', __('Thread not found.', 'wp-review-comments'), ['status' => 404]);
        }
        if (! in_array($status, self::STATUSES, true)) {
            return new WP_Error('wprc_bad_status', __('Unknown status.', 'wp-review-comments'), ['status' => 400]);
        }
        self::setMeta($id, '_wprc_status', $status);
        self::setMeta($id, '_wprc_activity', time());

        return true;
    }

    /**
     * Whether the current visitor wrote this comment: by account for
     * logged-in users, by the guest key cookie for guests.
     */
    public static function isOwnComment(WP_Post $post): bool
    {
        if ($post->post_author) {
            return (int) $post->post_author === get_current_user_id();
        }
        $key = Session::guestKey();
        $stored = (string) get_post_meta($post->ID, '_wprc_guest_key', true);

        return $key !== null && $stored !== '' && hash_equals($stored, hash('sha256', $key));
    }

    public static function canModify(WP_Post $post): bool
    {
        // Trashed and deleted comments are kept for restoring, not editing.
        if ($post->post_status !== 'publish' || get_post_meta($post->ID, '_wprc_deleted', true)) {
            return false;
        }

        return self::isOwnComment($post) || current_user_can('edit_others_posts');
    }

    /**
     * Save a JPEG screenshot (data URL) for a root comment under uploads.
     */
    public static function saveScreenshot(int $id, string $dataUrl): string|WP_Error
    {
        if (! preg_match('#^data:image/jpeg;base64,([A-Za-z0-9+/=]+)$#', $dataUrl, $match)) {
            return new WP_Error('wprc_bad_image', __('Screenshot must be a JPEG data URL.', 'wp-review-comments'), ['status' => 400]);
        }
        $bytes = base64_decode($match[1], true);
        $info = $bytes === false ? false : @getimagesizefromstring($bytes);
        if ($bytes === false || strlen($bytes) > 1.5 * MB_IN_BYTES || ! $info || $info[2] !== IMAGETYPE_JPEG || $info[0] > 4000 || $info[1] > 4000) {
            return new WP_Error('wprc_bad_image', __('Screenshot is too large or not a JPEG.', 'wp-review-comments'), ['status' => 400]);
        }
        $uploads = wp_upload_dir();
        $dir = trailingslashit($uploads['basedir']).'wp-review-comments';
        if (! wp_mkdir_p($dir)) {
            return new WP_Error('wprc_upload_dir', __('Cannot write screenshots.', 'wp-review-comments'), ['status' => 500]);
        }
        if (! file_exists($dir.'/index.php')) {
            file_put_contents($dir.'/index.php', "<?php // Silence is golden.\n");
        }
        if (get_post_meta($id, '_wprc_screenshot', true)) {
            return new WP_Error('wprc_has_screenshot', __('This comment already has a screenshot.', 'wp-review-comments'), ['status' => 409]);
        }
        // Unguessable name: the folder is public, like the rest of uploads.
        $file = $id.'-'.wp_generate_password(20, false, false).'.jpg';
        if (file_put_contents($dir.'/'.$file, $bytes) === false) {
            return new WP_Error('wprc_upload_write', __('Cannot write screenshots.', 'wp-review-comments'), ['status' => 500]);
        }
        self::setMeta($id, '_wprc_screenshot', $file);

        return trailingslashit($uploads['baseurl']).'wp-review-comments/'.$file;
    }

    public static function screenshotUrl(int $id): string
    {
        $file = (string) get_post_meta($id, '_wprc_screenshot', true);

        return $file ? trailingslashit(wp_upload_dir()['baseurl']).'wp-review-comments/'.$file : '';
    }

    private static function deleteScreenshot(int $id): void
    {
        $file = (string) get_post_meta($id, '_wprc_screenshot', true);
        if ($file !== '' && ! str_contains($file, '/')) {
            wp_delete_file(trailingslashit(wp_upload_dir()['basedir']).'wp-review-comments/'.$file);
        }
    }

    /**
     * Root threads, newest activity first.
     *
     * @param  array{url?:string,post_id?:int,status?:string|array<string>,round?:int,limit?:int}  $args
     * @return WP_Post[]
     */
    public static function queryThreads(array $args = []): array
    {
        $meta = [];
        if (! empty($args['url'])) {
            $meta[] = ['key' => '_wprc_url', 'value' => self::normalizeUrl($args['url'])];
        }
        if (! empty($args['post_id'])) {
            $meta[] = ['key' => '_wprc_post_id', 'value' => (int) $args['post_id']];
        }
        if (! empty($args['status'])) {
            $meta[] = ['key' => '_wprc_status', 'value' => (array) $args['status'], 'compare' => 'IN'];
        }
        if (! empty($args['round'])) {
            $meta[] = ['key' => '_wprc_round', 'value' => (int) $args['round']];
        }

        return get_posts([
            'post_type' => self::COMMENT,
            'post_status' => 'publish',
            'post_parent' => 0,
            'posts_per_page' => min(500, (int) ($args['limit'] ?? 200)),
            'meta_query' => $meta,
            'meta_key' => '_wprc_activity',
            'orderby' => 'meta_value_num',
            'order' => 'DESC',
        ]);
    }

    /** @return WP_Post[] */
    public static function replies(int $rootId): array
    {
        return get_posts([
            'post_type' => self::COMMENT,
            'post_status' => 'publish',
            'post_parent' => $rootId,
            'posts_per_page' => -1,
            'orderby' => 'date',
            'order' => 'ASC',
        ]);
    }

    /**
     * Stable key for a page: path plus meaningful query, without tracking
     * parameters, our own parameters or a trailing slash.
     */
    public static function normalizeUrl(string $url): string
    {
        $parts = wp_parse_url($url);
        $path = '/'.ltrim((string) ($parts['path'] ?? '/'), '/');
        // Stored relative to the site, so home_url($key) gives the page back on
        // subdirectory installs and multisite too.
        $home = function_exists('home_url') ? rtrim((string) wp_parse_url(home_url('/'), PHP_URL_PATH), '/') : '';
        if ($home !== '' && ($path === $home || str_starts_with($path, $home.'/'))) {
            $path = substr($path, strlen($home)) ?: '/';
        }
        $path = rtrim($path, '/') ?: '/';
        $query = [];
        if (! empty($parts['query'])) {
            parse_str($parts['query'], $query);
            foreach (array_keys($query) as $key) {
                if (in_array($key, self::IGNORED_PARAMS, true) || str_starts_with((string) $key, 'utm_')) {
                    unset($query[$key]);
                }
            }
            ksort($query);
        }

        return $path.($query ? '?'.http_build_query($query) : '');
    }

    /**
     * Screen size class from a "WIDTHxHEIGHT" viewport string.
     */
    public static function device(string $viewport): string
    {
        $width = (int) $viewport;

        return match (true) {
            $width === 0 => '',
            $width < 600 => 'mobile',
            $width < 1024 => 'tablet',
            default => 'desktop',
        };
    }

    /**
     * @return array<string, mixed>
     */
    public static function formatComment(WP_Post $post, bool $includeEmail = false): array
    {
        $user = $post->post_author ? get_userdata((int) $post->post_author) : null;
        $name = get_post_meta($post->ID, '_wprc_author_name', true) ?: ($user ? $user->display_name : __('Guest', 'wp-review-comments'));
        $comment = [
            'id' => $post->ID,
            'author' => $name,
            'author_type' => get_post_meta($post->ID, '_wprc_author_type', true) ?: 'user',
            'created' => get_post_time('c', true, $post),
            'edited' => (bool) get_post_meta($post->ID, '_wprc_edited', true),
            'deleted' => (bool) get_post_meta($post->ID, '_wprc_deleted', true),
            'text' => $post->post_content,
            'can_modify' => self::canModify($post),
        ];
        if ($includeEmail) {
            $comment['author_email'] = get_post_meta($post->ID, '_wprc_author_email', true) ?: ($user ? $user->user_email : '');
        }

        return $comment;
    }

    /**
     * @return array<string, mixed>
     */
    public static function formatThread(WP_Post $root, bool $includeEmail = false): array
    {
        $thread = self::formatComment($root, $includeEmail);
        $thread['status'] = get_post_meta($root->ID, '_wprc_status', true) ?: 'open';
        foreach (self::LOCATION_FIELDS as $field => $type) {
            $value = get_post_meta($root->ID, '_wprc_'.$field, true);
            $thread[$field] = match ($type) {
                'int' => (int) $value,
                'float' => (float) $value,
                default => (string) $value,
            };
        }
        if (! $includeEmail) {
            // Guests do not need each other's full user agent strings.
            unset($thread['user_agent']);
        }
        $thread['device'] = self::device($thread['viewport']);
        $thread['screenshot'] = self::screenshotUrl($root->ID);
        $thread['link'] = home_url($thread['url'] ?: '/').'#wprc-'.$root->ID;
        $thread['replies'] = array_map(
            fn (WP_Post $reply) => self::formatComment($reply, $includeEmail),
            self::replies($root->ID)
        );

        return $thread;
    }

    /** One line of plain text: valid UTF-8, no control characters. */
    private static function plainLine(string $value): string
    {
        return trim(preg_replace('/\p{C}+/u', ' ', wp_check_invalid_utf8($value)) ?? '');
    }

    private static function cleanText(mixed $text): string|WP_Error
    {
        $text = is_scalar($text) ? (string) $text : '';
        // Plain text, shown with textContent everywhere: keep "<" and "&" as
        // typed, drop invalid UTF-8 and control characters.
        $text = wp_check_invalid_utf8($text);
        $text = trim(preg_replace('/[^\P{C}\n\t]/u', '', str_replace(["\r\n", "\r"], "\n", $text)) ?? '');
        if ($text === '') {
            return new WP_Error('wprc_empty', __('Comment text is required.', 'wp-review-comments'), ['status' => 400]);
        }
        if (mb_strlen($text) > 5000) {
            return new WP_Error('wprc_too_long', __('Comment is too long.', 'wp-review-comments'), ['status' => 400]);
        }

        return $text;
    }
}

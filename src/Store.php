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

    public function register(): void
    {
        add_action('init', [self::class, 'registerPostTypes']);
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
            if (! $root || $root->post_type !== self::COMMENT || $root->post_parent) {
                return new WP_Error('wprc_bad_parent', __('Unknown thread.', 'wp-review-comments'), ['status' => 404]);
            }
        }

        $id = wp_insert_post([
            'post_type' => self::COMMENT,
            'post_status' => 'publish',
            'post_title' => wp_trim_words($text, 10, '…'),
            'post_content' => $text,
            'post_parent' => $parent,
            'post_author' => get_current_user_id(),
        ], true);
        if (is_wp_error($id)) {
            return $id;
        }

        update_post_meta($id, '_wprc_author_name', sanitize_text_field($data['author_name'] ?? ''));
        update_post_meta($id, '_wprc_author_email', sanitize_email($data['author_email'] ?? ''));
        update_post_meta($id, '_wprc_author_type', sanitize_key($data['author_type'] ?? 'user'));
        update_post_meta($id, '_wprc_round', (int) ($data['round'] ?? 0));
        if (! empty($data['guest_key'])) {
            update_post_meta($id, '_wprc_guest_key', hash('sha256', (string) $data['guest_key']));
        }

        if (! $parent) {
            update_post_meta($id, '_wprc_status', in_array($data['status'] ?? '', self::STATUSES, true) ? $data['status'] : 'open');
            foreach (self::LOCATION_FIELDS as $field => $type) {
                if (! isset($data[$field])) {
                    continue;
                }
                $value = match ($type) {
                    'int' => (int) $data[$field],
                    'float' => max(0, min(1, (float) $data[$field])),
                    // Raw `<` and `>` are fine in meta and escaped on output;
                    // sanitize_text_field would turn them into entities.
                    default => mb_substr(trim(wp_strip_all_tags((string) $data[$field], true)), 0, 500),
                };
                if ($field === 'url') {
                    $value = self::normalizeUrl($value);
                }
                update_post_meta($id, '_wprc_'.$field, $value);
            }
        }
        update_post_meta($parent ?: $id, '_wprc_activity', time());

        do_action(self::ACTION_CREATED, $id, (bool) $parent);

        return $id;
    }

    public static function updateText(int $id, string $text): true|WP_Error
    {
        $text = self::cleanText($text);
        if (is_wp_error($text)) {
            return $text;
        }
        wp_update_post(['ID' => $id, 'post_content' => $text, 'post_title' => wp_trim_words($text, 10, '…')]);
        update_post_meta($id, '_wprc_edited', time());

        return true;
    }

    /**
     * Delete a comment. A thread that others have replied to keeps its
     * replies and only loses its own text.
     */
    public static function deleteComment(int $id): true|WP_Error
    {
        $post = get_post($id);
        if (! $post || $post->post_type !== self::COMMENT) {
            return new WP_Error('wprc_not_found', __('Comment not found.', 'wp-review-comments'), ['status' => 404]);
        }
        if (! $post->post_parent && self::replies($id)) {
            wp_update_post(['ID' => $id, 'post_content' => '', 'post_title' => __('(deleted)', 'wp-review-comments')]);
            update_post_meta($id, '_wprc_deleted', time());

            return true;
        }
        self::deleteScreenshot($id);
        wp_delete_post($id, true);

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
        update_post_meta($id, '_wprc_status', $status);
        update_post_meta($id, '_wprc_activity', time());

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
        if ($bytes === false || strlen($bytes) > 1.5 * MB_IN_BYTES || ! str_starts_with($bytes, "\xFF\xD8")) {
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
        self::deleteScreenshot($id);
        // Unguessable name: the folder is public, like the rest of uploads.
        $file = $id.'-'.wp_generate_password(20, false, false).'.jpg';
        if (file_put_contents($dir.'/'.$file, $bytes) === false) {
            return new WP_Error('wprc_upload_write', __('Cannot write screenshots.', 'wp-review-comments'), ['status' => 500]);
        }
        update_post_meta($id, '_wprc_screenshot', $file);

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
                default => html_entity_decode((string) $value, ENT_QUOTES),
            };
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

    private static function cleanText(mixed $text): string|WP_Error
    {
        $text = trim(sanitize_textarea_field((string) $text));
        if ($text === '') {
            return new WP_Error('wprc_empty', __('Comment text is required.', 'wp-review-comments'), ['status' => 400]);
        }
        if (mb_strlen($text) > 5000) {
            return new WP_Error('wprc_too_long', __('Comment is too long.', 'wp-review-comments'), ['status' => 400]);
        }

        return $text;
    }
}

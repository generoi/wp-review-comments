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
     * @param  array{text:string,parent?:int,author_name?:string,author_email?:string,author_type?:string,round?:int,status?:string}  $data
     */
    public static function createComment(array $data): int|WP_Error
    {
        $text = trim(sanitize_textarea_field($data['text'] ?? ''));
        if ($text === '') {
            return new WP_Error('wprc_empty', __('Comment text is required.', 'wp-review-comments'), ['status' => 400]);
        }
        if (mb_strlen($text) > 5000) {
            return new WP_Error('wprc_too_long', __('Comment is too long.', 'wp-review-comments'), ['status' => 400]);
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

        if (! $parent) {
            update_post_meta($id, '_wprc_status', in_array($data['status'] ?? '', self::STATUSES, true) ? $data['status'] : 'open');
            foreach (self::LOCATION_FIELDS as $field => $type) {
                if (! isset($data[$field])) {
                    continue;
                }
                $value = match ($type) {
                    'int' => (int) $data[$field],
                    'float' => max(0, min(1, (float) $data[$field])),
                    default => mb_substr(sanitize_text_field((string) $data[$field]), 0, 500),
                };
                update_post_meta($id, '_wprc_'.$field, $value);
            }
        } else {
            // Bump the thread so recently active threads sort first.
            update_post_meta($parent, '_wprc_activity', time());
        }
        update_post_meta($parent ?: $id, '_wprc_activity', time());

        return $id;
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
     * Root threads, newest activity first.
     *
     * @param  array{url?:string,post_id?:int,status?:string|array,round?:int,limit?:int}  $args
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
     * Stable key for a page: path plus query, without our own parameters.
     */
    public static function normalizeUrl(string $url): string
    {
        $parts = wp_parse_url($url);
        $path = '/'.ltrim($parts['path'] ?? '/', '/');
        $path = untrailingslashit($path) ?: '/';
        $query = [];
        if (! empty($parts['query'])) {
            parse_str($parts['query'], $query);
            unset($query['review']);
            ksort($query);
        }

        return $path.($query ? '?'.http_build_query($query) : '');
    }

    public static function formatComment(WP_Post $post, bool $includeEmail = false): array
    {
        $user = $post->post_author ? get_userdata($post->post_author) : null;
        $name = get_post_meta($post->ID, '_wprc_author_name', true) ?: ($user ? $user->display_name : __('Guest', 'wp-review-comments'));
        $comment = [
            'id' => $post->ID,
            'author' => $name,
            'author_type' => get_post_meta($post->ID, '_wprc_author_type', true) ?: 'user',
            'created' => get_post_time('c', true, $post),
            'text' => $post->post_content,
        ];
        if ($includeEmail) {
            $comment['author_email'] = get_post_meta($post->ID, '_wprc_author_email', true) ?: ($user ? $user->user_email : '');
        }

        return $comment;
    }

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
        $thread['link'] = home_url($thread['url'] ?: '/').'#wprc-'.$root->ID;
        $thread['replies'] = array_map(
            fn (WP_Post $reply) => self::formatComment($reply, $includeEmail),
            self::replies($root->ID)
        );

        return $thread;
    }
}

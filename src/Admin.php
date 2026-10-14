<?php

namespace GeneroWP\ReviewComments;

use WP_Query;

/**
 * wp-admin: review rounds (guest links), connection info for Claude, and the
 * thread list.
 */
class Admin implements Module
{
    public const MENU_SLUG = 'wp-review-comments';

    public function register(): void
    {
        add_action('admin_menu', [$this, 'menu']);
        add_action('admin_post_wprc_create_round', [$this, 'createRound']);
        add_action('admin_post_wprc_revoke_round', [$this, 'revokeRound']);
        add_action('admin_post_wprc_save_settings', [$this, 'saveSettings']);
        add_action('pre_get_posts', [$this, 'onlyRootThreads']);
        add_filter('manage_'.Store::COMMENT.'_posts_columns', [$this, 'columns']);
        add_action('manage_'.Store::COMMENT.'_posts_custom_column', [$this, 'column'], 10, 2);
    }

    public function menu(): void
    {
        add_menu_page(
            __('Review', 'wp-review-comments'),
            __('Review', 'wp-review-comments'),
            'edit_posts',
            self::MENU_SLUG,
            [$this, 'page'],
            'dashicons-format-chat',
            26
        );
        add_submenu_page(
            self::MENU_SLUG,
            __('Rounds & links', 'wp-review-comments'),
            __('Rounds & links', 'wp-review-comments'),
            'edit_posts',
            self::MENU_SLUG,
            [$this, 'page']
        );
    }

    public function page(): void
    {
        $created = get_transient('wprc_new_link_'.get_current_user_id());
        if ($created) {
            delete_transient('wprc_new_link_'.get_current_user_id());
        }
        $rounds = get_posts(['post_type' => Store::ROUND, 'post_status' => 'publish', 'posts_per_page' => 100]);
        $mcpUrl = rest_url('review-comments/mcp');
        ?>
        <div class="wrap">
            <h1><?php esc_html_e('Review rounds', 'wp-review-comments'); ?></h1>
            <p><?php esc_html_e('Logged-in editors can always comment on the site from the Review button. To let people without an account comment, create a round and share its link.', 'wp-review-comments'); ?></p>

            <?php if ($created) { ?>
                <div class="notice notice-success">
                    <p><strong><?php esc_html_e('Share this link. It is shown only once:', 'wp-review-comments'); ?></strong></p>
                    <p><input type="text" class="large-text code" readonly value="<?php echo esc_attr($created); ?>" onclick="this.select()"></p>
                </div>
            <?php } ?>

            <form method="post" action="<?php echo esc_url(admin_url('admin-post.php')); ?>">
                <?php wp_nonce_field('wprc_create_round'); ?>
                <input type="hidden" name="action" value="wprc_create_round">
                <table class="form-table" role="presentation">
                    <tr>
                        <th scope="row"><label for="wprc-name"><?php esc_html_e('Name', 'wp-review-comments'); ?></label></th>
                        <td><input id="wprc-name" name="name" type="text" class="regular-text" placeholder="<?php esc_attr_e('Client review, redesign', 'wp-review-comments'); ?>" required></td>
                    </tr>
                    <tr>
                        <th scope="row"><label for="wprc-days"><?php esc_html_e('Valid for (days)', 'wp-review-comments'); ?></label></th>
                        <td><input id="wprc-days" name="days" type="number" min="1" max="365" value="30"></td>
                    </tr>
                </table>
                <?php submit_button(__('Create review link', 'wp-review-comments')); ?>
            </form>

            <h2><?php esc_html_e('Rounds', 'wp-review-comments'); ?></h2>
            <table class="widefat striped">
                <thead><tr>
                    <th><?php esc_html_e('Name', 'wp-review-comments'); ?></th>
                    <th><?php esc_html_e('Expires', 'wp-review-comments'); ?></th>
                    <th><?php esc_html_e('Status', 'wp-review-comments'); ?></th>
                    <th></th>
                </tr></thead>
                <tbody>
                <?php foreach ($rounds as $round) {
                    $active = Session::isRoundActive($round->ID);
                    ?>
                    <tr>
                        <td><?php echo esc_html($round->post_title); ?></td>
                        <td><?php echo esc_html(wp_date(get_option('date_format'), (int) get_post_meta($round->ID, '_wprc_expires', true))); ?></td>
                        <td><?php echo $active ? esc_html__('Active', 'wp-review-comments') : esc_html__('Closed', 'wp-review-comments'); ?></td>
                        <td>
                            <?php if ($active) { ?>
                                <form method="post" action="<?php echo esc_url(admin_url('admin-post.php')); ?>">
                                    <?php wp_nonce_field('wprc_revoke_round'); ?>
                                    <input type="hidden" name="action" value="wprc_revoke_round">
                                    <input type="hidden" name="round" value="<?php echo (int) $round->ID; ?>">
                                    <button class="button-link-delete" type="submit"><?php esc_html_e('Revoke', 'wp-review-comments'); ?></button>
                                </form>
                            <?php } ?>
                        </td>
                    </tr>
                <?php } ?>
                <?php if (! $rounds) { ?>
                    <tr><td colspan="4"><?php esc_html_e('No rounds yet.', 'wp-review-comments'); ?></td></tr>
                <?php } ?>
                </tbody>
            </table>

            <h2><?php esc_html_e('Notifications', 'wp-review-comments'); ?></h2>
            <?php $settings = Notifications::settings(); ?>
            <form method="post" action="<?php echo esc_url(admin_url('admin-post.php')); ?>">
                <?php wp_nonce_field('wprc_save_settings'); ?>
                <input type="hidden" name="action" value="wprc_save_settings">
                <table class="form-table" role="presentation">
                    <tr>
                        <th scope="row"><label for="wprc-webhook"><?php esc_html_e('Google Chat webhook', 'wp-review-comments'); ?></label></th>
                        <td>
                            <input id="wprc-webhook" name="chat_webhook" type="url" class="large-text code" value="<?php echo esc_attr($settings['chat_webhook']); ?>" placeholder="https://chat.googleapis.com/v1/spaces/…/messages?key=…&amp;token=…">
                            <p class="description"><?php esc_html_e('Space settings → Apps & integrations → Webhooks. Every new comment and reply is posted there, one Chat thread per review thread.', 'wp-review-comments'); ?></p>
                        </td>
                    </tr>
                    <tr>
                        <th scope="row"><?php esc_html_e('Email', 'wp-review-comments'); ?></th>
                        <td><label><input name="email_participants" type="checkbox" value="1" <?php checked($settings['email_participants']); ?>> <?php esc_html_e('Email everyone in a thread (who left an email address) when someone replies', 'wp-review-comments'); ?></label></td>
                    </tr>
                </table>
                <?php submit_button(__('Save notifications', 'wp-review-comments')); ?>
            </form>

            <h2><?php esc_html_e('Connect Claude', 'wp-review-comments'); ?></h2>
            <?php if (class_exists('\WP\MCP\Core\McpAdapter')) { ?>
                <p><?php esc_html_e('Create an application password under Users → Profile, then run:', 'wp-review-comments'); ?></p>
                <pre style="background:#fff;padding:12px;overflow:auto">claude mcp add --transport http review-<?php echo esc_html(sanitize_title(wp_parse_url(home_url(), PHP_URL_HOST))); ?> <?php echo esc_html($mcpUrl); ?> \
  --header "Authorization: Basic $(printf '%s' 'USERNAME:APPLICATION PASSWORD' | base64)"</pre>
            <?php } else { ?>
                <p><?php esc_html_e('Install and activate the MCP Adapter plugin (wordpress/mcp-adapter) to let Claude read these comments.', 'wp-review-comments'); ?></p>
            <?php } ?>
        </div>
        <?php
    }

    public function createRound(): void
    {
        check_admin_referer('wprc_create_round');
        if (! current_user_can('edit_posts')) {
            wp_die('', 403);
        }
        $round = Session::createRound((string) wp_unslash($_POST['name'] ?? ''), (int) ($_POST['days'] ?? 30));
        if (! is_wp_error($round)) {
            set_transient('wprc_new_link_'.get_current_user_id(), $round['link'], 5 * MINUTE_IN_SECONDS);
        }
        wp_safe_redirect(admin_url('admin.php?page='.self::MENU_SLUG));
        exit;
    }

    public function revokeRound(): void
    {
        check_admin_referer('wprc_revoke_round');
        if (! current_user_can('edit_posts')) {
            wp_die('', 403);
        }
        Session::revokeRound((int) ($_POST['round'] ?? 0));
        wp_safe_redirect(admin_url('admin.php?page='.self::MENU_SLUG));
        exit;
    }

    public function saveSettings(): void
    {
        check_admin_referer('wprc_save_settings');
        if (! current_user_can('manage_options')) {
            wp_die('', 403);
        }
        Notifications::saveSettings((string) wp_unslash($_POST['chat_webhook'] ?? ''), ! empty($_POST['email_participants']));
        wp_safe_redirect(admin_url('admin.php?page='.self::MENU_SLUG));
        exit;
    }

    public function onlyRootThreads(WP_Query $query): void
    {
        if (is_admin() && $query->is_main_query() && $query->get('post_type') === Store::COMMENT) {
            $query->set('post_parent', 0);
        }
    }

    public function columns(array $columns): array
    {
        return [
            'cb' => $columns['cb'] ?? '',
            'title' => __('Comment', 'wp-review-comments'),
            'wprc_status' => __('Status', 'wp-review-comments'),
            'wprc_page' => __('Page', 'wp-review-comments'),
            'wprc_author' => __('Author', 'wp-review-comments'),
            'wprc_replies' => __('Replies', 'wp-review-comments'),
            'date' => $columns['date'] ?? __('Date', 'wp-review-comments'),
        ];
    }

    public function column(string $column, int $id): void
    {
        switch ($column) {
            case 'wprc_status':
                echo esc_html(get_post_meta($id, '_wprc_status', true) ?: 'open');
                break;
            case 'wprc_page':
                $url = get_post_meta($id, '_wprc_url', true) ?: '/';
                $general = get_post_meta($id, '_wprc_selector', true) === '';
                printf('<a href="%s" target="_blank">%s</a>%s', esc_url(home_url($url).'#wprc-'.$id), esc_html($url), $general ? ' '.esc_html__('(general)', 'wp-review-comments') : '');
                break;
            case 'wprc_author':
                $thread = Store::formatComment(get_post($id));
                echo esc_html($thread['author'].' ('.$thread['author_type'].')');
                break;
            case 'wprc_replies':
                echo count(Store::replies($id));
                break;
        }
    }
}

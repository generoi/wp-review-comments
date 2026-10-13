<?php

namespace GeneroWP\ReviewComments;

/**
 * A tiny loader on every page. Pages are usually served from a page cache, so
 * it decides in the browser whether to load the overlay: for a review link
 * (?review=), an active guest session (flag cookie), a comment link
 * (#wprc-<id>), or an editor (logged-in pages bypass the cache).
 */
class Frontend implements Module
{
    public function register(): void
    {
        add_action('wp_footer', [$this, 'loader'], 100);
    }

    public function loader(): void
    {
        if (is_admin() || wp_doing_ajax() || is_feed() || is_embed()) {
            return;
        }

        $editor = Session::isEditor();
        $config = [
            'rest' => esc_url_raw(rest_url(Rest::NAMESPACE)),
            'nonce' => is_user_logged_in() ? wp_create_nonce('wp_rest') : '',
            'editor' => $editor,
            'user' => $editor ? wp_get_current_user()->display_name : '',
            'script' => plugins_url('assets/overlay.js', WP_REVIEW_COMMENTS_FILE).'?ver='.WP_REVIEW_COMMENTS_VERSION,
        ];
        ?>
        <script id="wprc-loader">
        (function (c) {
            var on = c.editor || /[?&]review=/.test(location.search) || /(^|; )wprc_on=1/.test(document.cookie) || /^#wprc-\d+$/.test(location.hash);
            if (!on) return;
            window.wprcConfig = c;
            var s = document.createElement('script');
            s.src = c.script;
            s.defer = true;
            document.body.appendChild(s);
        })(<?php echo wp_json_encode($config); ?>);
        </script>
        <?php
    }
}

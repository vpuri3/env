(put 'set-goal-column 'disabled nil)
(add-to-list 'auto-mode-alist '("\\.usr\\'" . fortran-mode))
(add-to-list 'auto-mode-alist '("\\.h\\'"   . c++-mode    ))

(set-face-foreground 'font-lock-comment-face "red")

(global-set-key "\C-h" (lambda () (interactive) (forward-line -10) (scroll-down 10)) )
(global-set-key "\C-j" (lambda () (interactive) (forward-line  10) (scroll-up   10)) )

(global-set-key "\t" 'indent-for-tab-command)

(autoload 'octave-mode "octave-mod" nil t)
(setq auto-mode-alist
      (cons '("\\.m$" . octave-mode) auto-mode-alist))